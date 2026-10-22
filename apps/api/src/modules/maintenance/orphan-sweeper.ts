import type { Logger } from 'pino';
import type { ExecutionProvider } from '../../execution/provider.js';
import type { StorageProvider } from '../../storage/provider.js';
import type { UserDatabaseProvider } from '../../userdb/provider.js';
import type { MaintenanceRepository } from './maintenance.repository.js';

export interface OrphanSweeperOptions {
  graceMs: number;
  dryRun: boolean;
}

export interface SweepStep {
  found: number;
  orphaned: number;
  removed: number;
  failed: number;
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

  sweep(): Promise<SweepReport> {
    return this.sweepOnce({ dryRun: this.options.dryRun });
  }

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

  private async sweepDatabases(dryRun: boolean): Promise<SweepStep> {
    const found = await this.databases.list();
    const step = blank(found.length);

    const rows = await this.repository.existingDatabaseNames(found.map((entry) => entry.name));

    for (const entry of found) {
      if (rows.has(entry.name)) continue;

      step.orphaned += 1;
      if (dryRun) continue;

      try {
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

  private async sweepSessions(now: Date, dryRun: boolean): Promise<number> {
    if (dryRun) return 0;

    try {
      return await this.repository.deleteExpiredSessions(now);
    } catch (error) {
      this.log.error({ err: error }, 'expired sessions could not be removed');
      return 0;
    }
  }

  private async sweepTokens(now: Date, dryRun: boolean): Promise<number> {
    if (dryRun) return 0;

    try {
      return await this.repository.deleteExpiredTokens(now);
    } catch (error) {
      this.log.error({ err: error }, 'expired account links could not be removed');
      return 0;
    }
  }

  private async step(name: string, work: () => Promise<SweepStep>): Promise<SweepStep> {
    try {
      return await work();
    } catch (error) {
      this.log.error({ err: error, step: name }, 'a cleanup step could not run');
      return { ...blank(0), skipped: messageOf(error) };
    }
  }

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
