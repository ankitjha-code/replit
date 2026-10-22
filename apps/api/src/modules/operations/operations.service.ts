import type { Logger } from 'pino';
import type {
  AccountQuota,
  OperationsAccount,
  OperationsHost,
  OperationsOverview,
  QuotaKind,
} from '@platform/shared';
import { AppError } from '../../errors/app-error.js';
import type { ExecutionHostConfig } from '../../execution/hosts.js';
import type { PlacementSource } from '../../execution/scheduler.js';
import type { ExecutionProvider } from '../../execution/provider.js';
import type { OrphanSweeper, SweepReport } from '../maintenance/orphan-sweeper.js';
import type { QuotaService } from '../quotas/quota.service.js';
import type { OperationsRepository } from './operations.repository.js';

export interface OperationsServiceOptions {
  hosts: readonly ExecutionHostConfig[];
  defaultHost: string;
  deploymentLimits: { cpuMillicores: number; memoryMb: number };
  accountPageSize: number;
}

export class OperationsService {
  constructor(
    private readonly operations: OperationsRepository,
    private readonly placement: PlacementSource,
    private readonly execution: ExecutionProvider,
    private readonly sweeper: OrphanSweeper,
    private readonly options: OperationsServiceOptions,
    private readonly log: Logger,
  ) {}

  private quotas: QuotaService | undefined;

  useQuotas(quotas: QuotaService): void {
    this.quotas = quotas;
  }

  async accountQuotas(targetId: string): Promise<AccountQuota[]> {
    const quotas = this.requireQuotas();
    const target = await this.operations.findAccount(targetId);
    if (!target)
      throw new AppError('NOT_FOUND', 'That account no longer exists.', { expose: true });
    return quotas.describeForOperator(targetId);
  }

  async setQuotaOverride(
    actorId: string,
    targetId: string,
    kind: QuotaKind,
    limit: number | null,
  ): Promise<AccountQuota[]> {
    const quotas = this.requireQuotas();
    const target = await this.operations.findAccount(targetId);
    if (!target)
      throw new AppError('NOT_FOUND', 'That account no longer exists.', { expose: true });

    await quotas.setOverride(targetId, kind, limit);
    await this.audit(actorId, limit === null ? 'quota.reset' : 'quota.override', {
      targetId,
      targetName: target.username,
      detail: { kind, limit },
    });

    return quotas.describeForOperator(targetId);
  }

  async setDrain(actorId: string, hostName: string, draining: boolean): Promise<OperationsHost[]> {
    if (!this.options.hosts.some((host) => host.name === hostName)) {
      throw new AppError('NOT_FOUND', 'There is no execution host with that name.', {
        expose: true,
      });
    }
    if (this.options.hosts.length < 2) {
      throw new AppError(
        'PRECONDITION_FAILED',
        'Draining needs more than one execution host: with one, there is nowhere else to place work.',
      );
    }

    await this.operations.setDrained(hostName, draining);
    await this.audit(actorId, draining ? 'host.drain' : 'host.undrain', {
      detail: { host: hostName },
    });
    this.log.warn(
      { actorId, host: hostName, draining },
      'an execution host was drained or restored',
    );
    return this.hosts();
  }

  private requireQuotas(): QuotaService {
    if (!this.quotas) throw new Error('Operations were built without the quota service');
    return this.quotas;
  }

  async overview(): Promise<OperationsOverview> {
    const counts = await this.operations.counts();

    return {
      accounts: {
        total: counts.accounts,
        verified: counts.verified,
        operators: counts.operators,
      },
      projects: { total: counts.projects, running: counts.runningRuntimes },
      deployments: { live: counts.liveDeployments, failed: counts.failedDeployments },
      jobs: { queued: counts.queuedJobs, running: counts.runningJobs, failed: counts.failedJobs },
    };
  }

  async hosts(): Promise<OperationsHost[]> {
    const [load, drained] = await Promise.all([
      this.placement.currentLoad(),
      this.operations.drainedHosts(),
    ]);

    return Promise.all(
      this.options.hosts.map(async (host) => {
        const placed = load.get(host.name) ??
          (host.name === this.options.defaultHost ? load.get('') : undefined) ?? {
            workloads: 0,
            cpuMillicores: 0,
            memoryMb: 0,
          };

        return {
          name: host.name,
          schedulable: host.schedulable && !drained.has(host.name),
          draining: drained.has(host.name),
          reason: await this.hostReason(),
          cpuMillicores: { used: placed.cpuMillicores, declared: host.cpuMillicores },
          memoryMb: { used: placed.memoryMb, declared: host.memoryMb },
          workloads: { used: placed.workloads, declared: host.maxWorkloads },
        };
      }),
    );
  }

  private hostReason(): Promise<string | null> {
    return this.execution
      .unavailableReason()
      .catch(() => 'The execution plane could not be asked.');
  }

  async accounts(after: string | undefined): Promise<{
    accounts: OperationsAccount[];
    nextCursor: string | null;
  }> {
    const limit = this.options.accountPageSize;

    const rows = await this.operations.accounts(limit + 1, after);
    const page = rows.slice(0, limit);

    return {
      accounts: page.map((row) => ({
        id: row.id,
        username: row.username,
        email: row.email,
        emailVerified: row.emailVerifiedAt !== null,
        isOperator: row.isOperator,
        projects: row.projects,
        createdAt: row.createdAt.toISOString(),
      })),
      nextCursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
    };
  }

  async setOperator(actorId: string, targetId: string, isOperator: boolean): Promise<void> {
    if (actorId === targetId && !isOperator) {
      throw new AppError(
        'VALIDATION_FAILED',
        'You cannot remove your own operator access. Ask another operator to do it.',
        { expose: true },
      );
    }

    const target = await this.operations.findAccount(targetId);
    if (!target)
      throw new AppError('NOT_FOUND', 'That account no longer exists.', { expose: true });

    if (target.isOperator === isOperator) return;

    if (!isOperator && (await this.operations.countOperators()) <= 1) {
      throw new AppError(
        'VALIDATION_FAILED',
        'That is the only operator. Grant somebody else access first.',
        { expose: true },
      );
    }

    await this.operations.setOperator(targetId, isOperator);

    await this.audit(actorId, isOperator ? 'operator.grant' : 'operator.revoke', {
      targetId,
      targetName: target.username,
    });

    this.log.warn(
      { actorId, targetId, username: target.username, isOperator },
      'operator access was changed',
    );
  }

  async auditTrail(): Promise<
    {
      id: string;
      actor: string;
      action: string;
      target: string | null;
      detail: unknown;
      at: string;
    }[]
  > {
    const rows = await this.operations.listAudit(this.options.accountPageSize);
    return rows.map((row) => ({
      id: row.id,
      actor: row.actorName,
      action: row.action,
      target: row.targetName,
      detail: row.detail,
      at: row.createdAt.toISOString(),
    }));
  }

  private async audit(
    actorId: string,
    action: string,
    extra: { targetId?: string; targetName?: string; detail?: Record<string, unknown> } = {},
  ): Promise<void> {
    try {
      const actor = await this.operations.findUsername(actorId);
      await this.operations.recordAudit({
        actorId,
        actorName: actor?.username ?? 'unknown',
        action,
        ...extra,
      });
    } catch (error) {
      this.log.error({ err: error, actorId, action }, 'an operator action could not be recorded');
    }
  }

  async sweep(actorId: string, dryRun: boolean): Promise<SweepReport> {
    this.log.warn({ actorId, dryRun }, 'a cleanup sweep was run by an operator');
    const report = await this.sweeper.sweepOnce({ dryRun });

    await this.audit(actorId, 'sweep.run', {
      detail: {
        dryRun,
        removed: {
          containers: report.containers.removed,
          networks: report.networks.removed,
          databases: report.databases.removed,
          objects: report.objects.removed,
        },
      },
    });

    return report;
  }
}
