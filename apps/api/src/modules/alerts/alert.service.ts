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

/**
 * Watching a deployment on somebody's behalf, and telling them when it is in
 * trouble.
 *
 * The one place the platform measures something nobody asked it to at that
 * moment. The monitoring page deliberately does not: its readings are taken
 * when somebody looks. An alert is exactly the case where nobody is looking, so
 * this is a periodic check — but only for projects whose owner turned it on, one
 * bounded batch at a time, from the worker rather than the API.
 *
 * ## What it will not do
 *
 *  - **Email anybody but the owner**, and only at a confirmed address. An alert
 *    to an address nobody proved is a way to make this platform send mail to a
 *    stranger on a timer.
 *  - **Email once per check.** One message when an alert starts and one when it
 *    clears.
 *  - **Pretend it told somebody.** Every start and clear is recorded with
 *    whether mail actually went, and the page shows it.
 */

export interface AlertServiceOptions {
  /** How long after one check a project is due another. */
  checkIntervalMs: number;
  /** How many projects one pass looks at. */
  batchSize: number;
  /** How many past events the page shows. */
  eventsShown: number;
  /** Where the web app is, for the link in an email. */
  publicUrl: string;
}

/** What is serving for a project right now, as the monitoring page measures it. */
export interface DeploymentReadings {
  deploymentReading(projectId: string): Promise<WatchedWorkload | null>;
}

/**
 * Memory must fall this far below the threshold before a memory alert clears.
 *
 * Without the gap, a workload hovering at the threshold would start and clear an
 * alert on alternate checks, which is the flood the one-email rule exists to
 * prevent.
 */
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

  /**
   * One pass: every project due a check, up to the batch size.
   *
   * Never rejects. Called from a timer, and one project failing to be checked
   * must not stop the others being checked.
   */
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

  /** Compares one reading with one project's settings, and acts on the difference. */
  async check(record: AlertStateRecord): Promise<void> {
    const reading = await this.readings.deploymentReading(record.projectId);

    let { consecutiveFailures, healthFiring, memoryFiring } = record;

    /*
     * Nothing deployed any more.
     *
     * Not a failure — the owner stopped it — so nothing new starts. Anything that
     * was firing is closed, with a message saying why, so the last word on the
     * page is not an alert about something that no longer exists.
     */
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

    // Health. "unknown" is neither: the platform could not ask, which says
    // nothing about the application.
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

    // Memory, only when watched and only when measured.
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

  // -------------------------------------------------------------------------

  /** Records an alert starting or clearing, and tells the owner if it can. */
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
