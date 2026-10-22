import type {
  AlertKind,
  AlertResponse,
  AlertSettings,
  AlertState,
  WatchedWorkload,
} from '@platform/shared';
import type { Logger } from 'pino';
import type { MailProvider } from '../../mail/provider.js';
import type { AlertRepository, AlertStateRecord } from './alert.repository.js';

export interface AlertServiceOptions {
  checkIntervalMs: number;
  batchSize: number;
  eventsShown: number;
  publicUrl: string;
}

export interface DeploymentReadings {
  deploymentReading(projectId: string): Promise<WatchedWorkload | null>;
}

const MEMORY_HYSTERESIS_PERCENT = 5;

export class AlertService {
  constructor(
    private readonly alerts: AlertRepository,
    private readonly readings: DeploymentReadings,
    private readonly mail: MailProvider,
    private readonly options: AlertServiceOptions,
    private readonly log: Logger,
  ) {}

  async describe(projectId: string): Promise<AlertResponse> {
    const [record, events] = await Promise.all([
      this.alerts.find(projectId),
      this.alerts.events(projectId, this.options.eventsShown),
    ]);

    const settings: AlertSettings = record
      ? {
          enabled: record.enabled,
          failuresBeforeAlert: record.failuresBeforeAlert,
          memoryPercent: record.memoryPercent,
        }
      : { enabled: false, failuresBeforeAlert: 3, memoryPercent: null };

    const firing: AlertKind[] = [];
    if (record?.healthFiring) firing.push('HEALTH');
    if (record?.memoryFiring) firing.push('MEMORY');

    return {
      settings,
      firing,
      lastCheckedAt: record?.lastCheckedAt?.toISOString() ?? null,
      events: events.map((event) => ({
        id: event.id,
        kind: event.kind,
        state: event.state,
        message: event.message,
        notified: event.notified,
        at: event.createdAt.toISOString(),
      })),
      deliveryProblem: await this.deliveryProblem(projectId),
    };
  }

  async update(projectId: string, settings: AlertSettings): Promise<AlertResponse> {
    await this.alerts.save(projectId, settings);
    this.log.info({ projectId, ...settings }, 'alert settings changed');
    return this.describe(projectId);
  }

  async evaluate(): Promise<number> {
    let due: AlertStateRecord[];
    try {
      due = await this.alerts.claimDue(this.options.checkIntervalMs, this.options.batchSize);
    } catch (error) {
      this.log.error({ err: error }, 'alerts could not be checked');
      return 0;
    }

    for (const record of due) {
      try {
        await this.check(record);
      } catch (error) {
        this.log.error({ err: error, projectId: record.projectId }, 'an alert check failed');
      }
    }
    return due.length;
  }

  async check(record: AlertStateRecord): Promise<void> {
    const reading = await this.readings.deploymentReading(record.projectId);

    let { consecutiveFailures, healthFiring, memoryFiring } = record;

    if (!reading) {
      if (healthFiring) {
        await this.transition(
          record.projectId,
          'HEALTH',
          'RESOLVED',
          'The deployment was stopped.',
        );
      }
      if (memoryFiring) {
        await this.transition(
          record.projectId,
          'MEMORY',
          'RESOLVED',
          'The deployment was stopped.',
        );
      }
      await this.alerts.saveState(record.projectId, {
        consecutiveFailures: 0,
        healthFiring: false,
        memoryFiring: false,
      });
      return;
    }

    const state = reading.health.state;
    if (state === 'unhealthy' || state === 'unreachable') consecutiveFailures += 1;
    if (state === 'healthy') consecutiveFailures = 0;

    if (!healthFiring && consecutiveFailures >= record.failuresBeforeAlert) {
      healthFiring = true;
      await this.transition(
        record.projectId,
        'HEALTH',
        'FIRING',
        `The deployment failed its health check ${String(consecutiveFailures)} times in a row. ${reading.health.message ?? ''}`.trim(),
      );
    } else if (healthFiring && state === 'healthy') {
      healthFiring = false;
      await this.transition(
        record.projectId,
        'HEALTH',
        'RESOLVED',
        'The deployment is passing its health check again.',
      );
    }

    const usage = reading.usage;
    if (record.memoryPercent !== null && usage?.memoryBytes != null && usage.memoryLimitBytes > 0) {
      const percent = (usage.memoryBytes / usage.memoryLimitBytes) * 100;

      if (!memoryFiring && percent >= record.memoryPercent) {
        memoryFiring = true;
        await this.transition(
          record.projectId,
          'MEMORY',
          'FIRING',
          `The deployment is using ${String(Math.round(percent))}% of its memory, above the ${String(record.memoryPercent)}% you set. At 100% it will be stopped.`,
        );
      } else if (memoryFiring && percent < record.memoryPercent - MEMORY_HYSTERESIS_PERCENT) {
        memoryFiring = false;
        await this.transition(
          record.projectId,
          'MEMORY',
          'RESOLVED',
          `Memory use is back down to ${String(Math.round(percent))}%.`,
        );
      }
    } else if (record.memoryPercent === null && memoryFiring) {
      memoryFiring = false;
    }

    await this.alerts.saveState(record.projectId, {
      consecutiveFailures,
      healthFiring,
      memoryFiring,
    });
  }

  private async transition(
    projectId: string,
    kind: AlertKind,
    state: AlertState,
    message: string,
  ): Promise<void> {
    const notified = await this.notify(projectId, kind, state, message);
    await this.alerts.recordEvent(projectId, { kind, state, message, notified });
    this.log.warn({ projectId, kind, state, notified }, 'an alert changed state');
  }

  private async notify(
    projectId: string,
    kind: AlertKind,
    state: AlertState,
    message: string,
  ): Promise<boolean> {
    if (await this.deliveryProblem(projectId)) return false;

    const recipient = await this.alerts.recipient(projectId);
    if (!recipient) return false;

    const what = kind === 'HEALTH' ? 'health check' : 'memory';
    const subject =
      state === 'FIRING'
        ? `${recipient.projectName}: ${what} alert`
        : `${recipient.projectName}: ${what} alert cleared`;

    try {
      await this.mail.send({
        to: recipient.email,
        subject,
        text: [
          `Hello ${recipient.username},`,
          '',
          message,
          '',
          `Project settings: ${this.options.publicUrl}/projects/${projectId}/settings`,
          '',
          'You are receiving this because alerts are turned on for this project.',
          'Turn them off on the same page.',
        ].join('\n'),
      });
      return true;
    } catch (error) {
      this.log.error({ err: error, projectId }, 'an alert email could not be sent');
      return false;
    }
  }

  private async deliveryProblem(projectId: string): Promise<string | null> {
    const reason = await this.mail.unavailableReason();
    if (reason) return `This installation cannot send email: ${reason}`;

    const recipient = await this.alerts.recipient(projectId);
    if (recipient && !recipient.emailVerified) {
      return 'The owner of this project has not confirmed their email address, so alerts are recorded here but not sent.';
    }
    return null;
  }
}
