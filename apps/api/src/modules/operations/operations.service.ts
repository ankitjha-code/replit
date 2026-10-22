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

/**
 * The installation, for the people who run it.
 *
 * Every other surface in this platform is scoped to a project or an account,
 * which is right for the people using it and leaves nobody able to answer "is
 * this installation healthy" without reading logs on the machine. That is
 * workable for one operator who also wrote the deployment, and not for anybody
 * else.
 *
 * ## What an operator may not do
 *
 * **Nothing here touches a project's contents.** No files, no secrets, no logs,
 * no terminal, no runtime. A project appears as a name, an owner and some
 * numbers, and there is no endpoint that widens that — an operator who wants
 * into a project has to be added to it by somebody who can, which leaves a trace
 * on the project itself.
 *
 * That is the difference between an operator and a backdoor, and it is worth
 * stating as a rule because the pressure to relax it will arrive as a support
 * request: somebody will want to "just look at" a customer's file.
 *
 * ## Every action is logged with who did it
 *
 * The read side is unremarkable. The act of granting somebody operator, or
 * running a sweep that deletes containers, is not: it is the kind of thing that
 * has to be attributable afterwards, and the log line is the only record.
 */

export interface OperationsServiceOptions {
  hosts: readonly ExecutionHostConfig[];
  /** The host a workload with no host recorded belongs to. */
  defaultHost: string;
  /** What each deployment is allowed, which is not recorded per deployment. */
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

  /** One account's ceilings, with which of them are exceptions. */
  async accountQuotas(targetId: string): Promise<AccountQuota[]> {
    const quotas = this.requireQuotas();
    const target = await this.operations.findAccount(targetId);
    if (!target)
      throw new AppError('NOT_FOUND', 'That account no longer exists.', { expose: true });
    return quotas.describeForOperator(targetId);
  }

  /**
   * Raises or lowers one account's ceiling, or puts it back on the default.
   *
   * Lowering one below what the account is already using stops nothing that is
   * running: the ceiling is checked when something starts, so the account is
   * simply refused its next start until it is back under. Stopping somebody's
   * work is a different, larger decision than this one.
   */
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

  /**
   * Takes a host out of placement, or puts it back.
   *
   * Only with more than one host. With one, the platform does not route at all
   * — every workload goes to the only machine there is — so a drain would be a
   * row that changed nothing, which is the kind of control that lies.
   *
   * Nothing running is stopped. Workloads on a drained host stay there until
   * they are next restarted, when they are placed somewhere else; moving one
   * sooner would mean stopping somebody's running program, which is a larger
   * decision than this one and not the platform's to make on their behalf.
   */
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

  /**
   * Each execution host against the capacity an operator declared for it.
   *
   * Declared, not measured. The platform schedules against what somebody said a
   * machine may give it, and showing the machine's own totals would invite the
   * mistake the declaration exists to prevent: filling a host that is also doing
   * something else.
   *
   * The reason a host cannot be used is asked of the host itself, so a machine
   * that is configured and unreachable is visibly different from one that was
   * taken out of the rotation on purpose.
   */
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

  /**
   * Whether the execution plane as a whole can be used.
   *
   * Not per host, and that is a limitation rather than a choice: the provider
   * port answers for the plane, and asking one machine specifically would mean
   * reaching past it into the routing provider's map. A single-host installation
   * — which is most of them — gets an exactly correct answer; a multi-host one
   * gets "something is reachable", which is honest and less than it should be.
   */
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

    // One more than the page, so "is there another page" is answered by the
    // query rather than by a second count that can disagree with it.
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

  /**
   * Grants or removes operator.
   *
   * Two rules, and both are about not locking everybody out:
   *
   *  - **An operator cannot remove their own flag.** The mistake is one click,
   *    and on an installation with one operator it is unrecoverable without
   *    database access. Somebody who genuinely wants to step down asks another
   *    operator, which is also a record of it happening.
   *  - **The last operator cannot be removed.** An installation with none has no
   *    way back except the machine.
   */
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

  /** The most recent operator actions, newest first. */
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

  /**
   * Writes an action down, and refuses to lose it quietly.
   *
   * The username is read now and stored beside the id, so the entry still reads
   * after the account is closed. A failure to record is logged loudly and does
   * not undo the action: the action has already happened, and pretending it had
   * not would be the worse record.
   */
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

  /**
   * Runs a cleanup pass now, rather than waiting for the timer.
   *
   * This is the surface task 57 deliberately did without, because it needed
   * somebody to be an operator and nobody could be. It defaults to the dry run:
   * the first thing anybody wants from a routine that deletes containers is to
   * watch it decide without letting it act.
   *
   * It runs in whichever process serves the request, which is the API rather
   * than the worker. That is a deliberate exception to "sweeps live in the
   * worker": somebody is waiting for the answer, and the alternative is a job,
   * a row, and a page that polls for a report.
   */
  async sweep(actorId: string, dryRun: boolean): Promise<SweepReport> {
    this.log.warn({ actorId, dryRun }, 'a cleanup sweep was run by an operator');
    const report = await this.sweeper.sweepOnce({ dryRun });

    // What it found and what it removed, because "an operator ran the sweep" is
    // not enough to answer "where did that container go?" a week later.
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
