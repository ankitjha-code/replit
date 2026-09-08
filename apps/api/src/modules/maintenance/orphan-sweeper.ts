import type { Logger } from 'pino';
import type { ExecutionProvider } from '../../execution/provider.js';
import type { StorageProvider } from '../../storage/provider.js';
import type { UserDatabaseProvider } from '../../userdb/provider.js';
import type { MaintenanceRepository } from './maintenance.repository.js';

/**
 * Finding what the platform made and then lost track of.
 *
 * Everything this platform creates lives in two places: a row that says it
 * should exist, and a thing on a machine somewhere that does. They come apart,
 * and always will:
 *
 *  - a container is created, and the transaction that would have recorded it
 *    rolls back;
 *  - a project is deleted while the host holding its container is unreachable,
 *    so the delete is logged and the project goes anyway;
 *  - a database drop fails because its server is down, and the project's row is
 *    removed regardless, because refusing to delete a project until an
 *    unrelated server comes back would be worse;
 *  - an object is uploaded and the row naming it fails to insert.
 *
 * Each of those was a deliberate decision to prefer a leak over a failure. This
 * is the other half of that bargain: something that periodically goes and
 * looks.
 *
 * ## The one rule that makes this safe
 *
 * **The sweep only ever removes things it found on the outside.** It reads rows
 * solely to decide what to leave alone, never to decide what to delete. That
 * direction is why a database outage cannot make it destructive: with no rows
 * to compare against it removes nothing, because the comparison it is doing is
 * "this container exists and no row claims it", and the first half is what it
 * enumerates.
 *
 * It follows that an empty listing is harmless and a failed listing must stop
 * that step, which is why every step is wrapped and reported separately.
 *
 * ## Nothing young is ever touched
 *
 * A container that exists for a moment before its row does is an ordinary race,
 * not an orphan. Every candidate must be older than a grace period, and
 * anything whose age cannot be determined is treated as young — the timid
 * reading, because the cost of waiting another hour is nothing and the cost of
 * removing a container somebody is using is somebody's work.
 */

export interface OrphanSweeperOptions {
  /** How old something must be before it may be considered abandoned. */
  graceMs: number;
  /**
   * Report what would be removed, and remove nothing.
   *
   * Worth having rather than clever: the first thing an operator wants from a
   * routine that deletes containers is to watch it not delete them for a while.
   */
  dryRun: boolean;
}

export interface SweepStep {
  /** How many the outside world reported. */
  found: number;
  /** How many of those nothing in the database claimed, and were old enough. */
  orphaned: number;
  removed: number;
  failed: number;
  /** Why this step did nothing, when it did nothing. */
  skipped?: string;
}

export interface SweepReport {
  startedAt: Date;
  finishedAt: Date;
  dryRun: boolean;
  containers: SweepStep;
  networks: SweepStep;
  databases: SweepStep;
  objects: SweepStep;
  sessions: { removed: number };
  tokens: { removed: number };
}

/** Where in object storage this platform puts things, and nowhere else. */
const OWNED_PREFIXES = ['snapshots/', 'repositories/', 'projects/'];

export class OrphanSweeper {
  constructor(
    private readonly repository: MaintenanceRepository,
    private readonly execution: ExecutionProvider,
    private readonly storage: StorageProvider,
    private readonly databases: UserDatabaseProvider,
    private readonly options: OrphanSweeperOptions,
    private readonly log: Logger,
  ) {}

  /**
   * One pass over everything.
   *
   * Steps run in sequence rather than together. They are not urgent, they each
   * talk to a different machine, and a sweep that hit the container runtime,
   * the object store and a database server simultaneously would be a small
   * traffic spike arriving on a timer.
   */
  sweep(): Promise<SweepReport> {
    return this.sweepOnce({ dryRun: this.options.dryRun });
  }

  /**
   * One pass, with the dry-run decision made by the caller.
   *
   * Separate from `sweep` so an operator can ask for a dry run on an
   * installation configured to act, and the other way round, without either
   * changing what the timer does next. The configured value is the default and
   * the timer always uses it.
   */
  async sweepOnce(options: { dryRun: boolean }): Promise<SweepReport> {
    const dryRun = options.dryRun;
    const startedAt = new Date();
    const before = new Date(startedAt.getTime() - this.options.graceMs);

    const report: SweepReport = {
      startedAt,
      finishedAt: startedAt,
      dryRun,
      containers: await this.step('containers', () => this.sweepContainers(before, dryRun)),
      networks: await this.step('networks', () => this.sweepNetworks(before, dryRun)),
      databases: await this.step('databases', () => this.sweepDatabases(dryRun)),
      objects: await this.step('objects', () => this.sweepObjects(before, dryRun)),
      sessions: { removed: await this.sweepSessions(startedAt, dryRun) },
      tokens: { removed: await this.sweepTokens(startedAt, dryRun) },
    };

    report.finishedAt = new Date();

    this.log.info({ report }, 'a cleanup sweep finished');
    return report;
  }

  /**
   * Containers the platform made that no row claims any more.
   *
   * Matched by the identifier in the container's own label rather than by the
   * container id, which catches a case the other direction misses: a runtime
   * row that exists but points at a *different* container. That happens when a
   * start failed halfway and was tried again, and the first container is as
   * abandoned as one whose row is gone.
   */
  private async sweepContainers(before: Date, dryRun: boolean): Promise<SweepStep> {
    const workloads = await this.execution.listWorkloads();
    const step = blank(workloads.length);

    const runtimeIds = ids(workloads, 'runtime');
    const deploymentIds = ids(workloads, 'deployment');

    const [runtimes, deployments] = await Promise.all([
      this.repository.runtimeExternalIds(runtimeIds),
      this.repository.deploymentExternalIds(deploymentIds),
    ]);

    for (const workload of workloads) {
      /*
       * A container the platform cannot identify is left alone, loudly.
       *
       * It carries this platform's managed label and nothing else useful, which
       * should not happen. Removing it would be acting on something not
       * understood; ignoring it silently would hide a real bug in labelling.
       */
      if (workload.kind === 'unknown' || !workload.workloadId) {
        this.log.warn(
          { externalId: workload.externalId },
          'a managed container carries no usable labels and was left alone',
        );
        continue;
      }

      if (!this.isOldEnough(workload.createdAt, before)) continue;

      const claimed =
        workload.kind === 'runtime'
          ? runtimes.get(workload.workloadId)
          : deployments.get(workload.workloadId);

      // Undefined means no such row. Null means a row that points at nothing,
      // which no container can match. A different value means a later generation
      // of the same workload, and this one is the leftover.
      const stillClaimed = claimed !== undefined && claimed === workload.externalId;
      if (stillClaimed) continue;

      step.orphaned += 1;
      if (dryRun) continue;

      try {
        await this.execution.destroy({ externalId: workload.externalId });
        step.removed += 1;
        this.log.info(
          { externalId: workload.externalId, kind: workload.kind, projectId: workload.projectId },
          'an abandoned container was removed',
        );
      } catch (error) {
        step.failed += 1;
        this.log.error(
          { err: error, externalId: workload.externalId },
          'an abandoned container could not be removed',
        );
      }
    }

    return step;
  }

  /**
   * Per-project networks whose project is gone.
   *
   * Only that case. A network belonging to a live project is left alone even
   * when nothing is attached to it: providers cache the fact that a network
   * exists, and removing one out from under a process that has already decided
   * it is there would make the next workload for that project fail to start.
   *
   * The attachment count is checked as well, because a project row can be gone
   * while its last container is still being torn down, and disconnecting a
   * running container from its network is a worse failure than leaving a
   * network for another hour.
   */
  private async sweepNetworks(before: Date, dryRun: boolean): Promise<SweepStep> {
    const networks = await this.execution.listNetworks();
    const step = blank(networks.length);

    const projectIds = [
      ...new Set(
        networks.map((network) => network.projectId).filter((id): id is string => id !== undefined),
      ),
    ];
    const projects = await this.repository.existingProjectIds(projectIds);

    for (const network of networks) {
      if (!network.projectId) continue;
      if (projects.has(network.projectId)) continue;
      if (network.attached > 0) continue;
      if (!this.isOldEnough(network.createdAt, before)) continue;

      step.orphaned += 1;
      if (dryRun) continue;

      try {
        await this.execution.removeNetwork(network.id);
        step.removed += 1;
        this.log.info(
          { network: network.name, projectId: network.projectId },
          "a deleted project's network was removed",
        );
      } catch (error) {
        step.failed += 1;
        this.log.error({ err: error, network: network.name }, 'a network could not be removed');
      }
    }

    return step;
  }

  /**
   * Project databases with no row.
   *
   * The one sweep with no grace period, because there is nothing to measure: a
   * PostgreSQL server does not record when a database was created. What makes
   * that acceptable is the order provisioning happens in — the row is written
   * **before** the database is made, so a database without one was never
   * recorded rather than not yet recorded.
   *
   * That invariant lives in the database service. If it ever reverses, this
   * sweep starts deleting databases seconds after they are created, so it is
   * stated here as a dependency rather than assumed.
   */
  private async sweepDatabases(dryRun: boolean): Promise<SweepStep> {
    const found = await this.databases.list();
    const step = blank(found.length);

    const rows = await this.repository.existingDatabaseNames(found.map((entry) => entry.name));

    for (const entry of found) {
      if (rows.has(entry.name)) continue;

      step.orphaned += 1;
      if (dryRun) continue;

      try {
        /*
         * The role goes with the database.
         *
         * Dropping a database leaves its owner behind, and a role nobody can
         * name is the same leak wearing different clothes. The owner reported by
         * the server is used rather than one derived from the name, because the
         * derivation is the thing that might have gone wrong.
         */
        await this.databases.drop({ name: entry.name, role: entry.role ?? entry.name });
        step.removed += 1;
        this.log.info({ database: entry.name }, 'an abandoned project database was dropped');
      } catch (error) {
        step.failed += 1;
        this.log.error(
          { err: error, database: entry.name },
          'an abandoned project database could not be dropped',
        );
      }
    }

    return step;
  }

  /**
   * Stored objects nothing references.
   *
   * Only under the prefixes this platform writes to. A bucket can be shared, and
   * a cleanup routine that enumerated the whole of one would eventually be
   * handed somebody else's files.
   *
   * Here the grace period is doing real work: an asset is written to the store
   * and *then* recorded, so an object uploaded a second ago legitimately has no
   * row. That ordering is the opposite of the database one above, and both are
   * right — bytes that fail to store must not leave a row, and a database that
   * fails to create must.
   */
  private async sweepObjects(before: Date, dryRun: boolean): Promise<SweepStep> {
    const step = blank(0);

    for (const prefix of OWNED_PREFIXES) {
      const objects = await this.storage.list(prefix);
      step.found += objects.length;

      const candidates = objects.filter((object) => this.isOldEnough(object.lastModified, before));
      if (candidates.length === 0) continue;

      const referenced = await this.repository.referencedStorageKeys(
        candidates.map((object) => object.key),
      );

      for (const object of candidates) {
        if (referenced.has(object.key)) continue;

        step.orphaned += 1;
        if (dryRun) continue;

        try {
          await this.storage.delete(object.key);
          step.removed += 1;
          this.log.info(
            { storageKey: object.key, bytes: object.size },
            'an unreferenced stored object was removed',
          );
        } catch (error) {
          step.failed += 1;
          this.log.error(
            { err: error, storageKey: object.key },
            'an unreferenced stored object could not be removed',
          );
        }
      }
    }

    return step;
  }

  /** Expired sessions, which need no comparison with anything outside. */
  private async sweepSessions(now: Date, dryRun: boolean): Promise<number> {
    if (dryRun) return 0;

    try {
      return await this.repository.deleteExpiredSessions(now);
    } catch (error) {
      this.log.error({ err: error }, 'expired sessions could not be removed');
      return 0;
    }
  }

  /** Expired verification and reset links, for the same reason as sessions. */
  private async sweepTokens(now: Date, dryRun: boolean): Promise<number> {
    if (dryRun) return 0;

    try {
      return await this.repository.deleteExpiredTokens(now);
    } catch (error) {
      this.log.error({ err: error }, 'expired account links could not be removed');
      return 0;
    }
  }

  /**
   * Runs one step, and turns a failure into a step that did nothing.
   *
   * A sweep is four independent pieces of work against four different machines.
   * One being unreachable must not stop the other three, and must not look like
   * a step that found nothing: `skipped` carries the reason, so a report showing
   * zero orphans can be told apart from one that never looked.
   */
  private async step(name: string, work: () => Promise<SweepStep>): Promise<SweepStep> {
    try {
      return await work();
    } catch (error) {
      this.log.error({ err: error, step: name }, 'a cleanup step could not run');
      return { ...blank(0), skipped: messageOf(error) };
    }
  }

  /**
   * Whether something is old enough to be considered abandoned.
   *
   * An unknown age answers no. The alternative — treating "I could not tell"
   * as "old enough" — makes every container whose creation time failed to parse
   * a candidate for deletion, which is exactly the wrong way round.
   */
  private isOldEnough(at: Date | undefined, before: Date): boolean {
    if (!at) return false;
    return at.getTime() < before.getTime();
  }
}

function blank(found: number): SweepStep {
  return { found, orphaned: 0, removed: 0, failed: 0 };
}

function ids(
  workloads: readonly { kind: string; workloadId: string | undefined }[],
  kind: string,
): string[] {
  return [
    ...new Set(
      workloads
        .filter((workload) => workload.kind === kind)
        .map((workload) => workload.workloadId)
        .filter((id): id is string => id !== undefined),
    ),
  ];
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'The step failed for an unrecorded reason.';
}
