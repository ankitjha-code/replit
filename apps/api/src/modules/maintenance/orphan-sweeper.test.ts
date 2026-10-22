import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import type {
  ExecutionProvider,
  ManagedNetwork,
  ManagedWorkload,
} from '../../execution/provider.js';
import type { StorageProvider, StoredObject } from '../../storage/provider.js';
import type { UserDatabaseProvider } from '../../userdb/provider.js';
import type { MaintenanceRepository } from './maintenance.repository.js';
import { OrphanSweeper } from './orphan-sweeper.js';

const HOUR = 60 * 60_000;
const old = new Date(Date.now() - 2 * HOUR);
const young = new Date(Date.now() - 60_000);

function workload(overrides: Partial<ManagedWorkload> = {}): ManagedWorkload {
  return {
    externalId: 'c-1',
    kind: 'runtime',
    workloadId: 'r-1',
    projectId: 'p-1',
    state: 'exited',
    createdAt: old,
    ...overrides,
  };
}

function build(
  options: {
    workloads?: ManagedWorkload[];
    networks?: ManagedNetwork[];
    objects?: StoredObject[];
    databases?: { name: string; role: string | null }[];
    runtimes?: Map<string, string | null>;
    projects?: Set<string>;
    keys?: Set<string>;
    databaseNames?: Set<string>;
    databaseDown?: boolean;
    dryRun?: boolean;
  } = {},
) {
  const destroyed: string[] = [];
  const removedNetworks: string[] = [];
  const deletedObjects: string[] = [];
  const dropped: string[] = [];

  const down = () => Promise.reject(new Error('the database is unreachable'));

  const repository = {
    runtimeExternalIds: () =>
      options.databaseDown ? down() : Promise.resolve(options.runtimes ?? new Map()),
    deploymentExternalIds: () => (options.databaseDown ? down() : Promise.resolve(new Map())),
    existingProjectIds: () =>
      options.databaseDown ? down() : Promise.resolve(options.projects ?? new Set()),
    referencedStorageKeys: () =>
      options.databaseDown ? down() : Promise.resolve(options.keys ?? new Set()),
    existingDatabaseNames: () =>
      options.databaseDown ? down() : Promise.resolve(options.databaseNames ?? new Set()),
    deleteExpiredSessions: () => (options.databaseDown ? down() : Promise.resolve(0)),
    deleteExpiredTokens: () => (options.databaseDown ? down() : Promise.resolve(0)),
  } as unknown as MaintenanceRepository;

  const execution = {
    listWorkloads: () => Promise.resolve(options.workloads ?? []),
    listNetworks: () => Promise.resolve(options.networks ?? []),
    destroy: (handle: { externalId: string }) => {
      destroyed.push(handle.externalId);
      return Promise.resolve();
    },
    removeNetwork: (id: string) => {
      removedNetworks.push(id);
      return Promise.resolve();
    },
  } as unknown as ExecutionProvider;

  const storage = {
    list: (prefix: string) =>
      Promise.resolve((options.objects ?? []).filter((object) => object.key.startsWith(prefix))),
    delete: (key: string) => {
      deletedObjects.push(key);
      return Promise.resolve();
    },
  } as unknown as StorageProvider;

  const databases = {
    list: () => Promise.resolve(options.databases ?? []),
    drop: (spec: { name: string }) => {
      dropped.push(spec.name);
      return Promise.resolve();
    },
  } as unknown as UserDatabaseProvider;

  const sweeper = new OrphanSweeper(
    repository,
    execution,
    storage,
    databases,
    { graceMs: HOUR, dryRun: options.dryRun ?? false },
    pino({ level: 'silent' }),
  );

  return { sweeper, destroyed, removedNetworks, deletedObjects, dropped };
}

describe('the one rule that makes it safe', () => {
  it('removes nothing at all when the database cannot be reached', async () => {
    // The whole safety argument: with no rows to compare against, the sweep
    // must do nothing — not conclude that everything it found is abandoned.
    const { sweeper, destroyed, removedNetworks, deletedObjects, dropped } = build({
      databaseDown: true,
      workloads: [workload()],
      networks: [{ id: 'n-1', name: 'net', projectId: 'p-1', attached: 0, createdAt: old }],
      objects: [{ key: 'snapshots/p-1/x.tar', size: 1, lastModified: old }],
      databases: [{ name: 'p_abc', role: 'r_abc' }],
    });

    const report = await sweeper.sweep();

    expect(destroyed).toEqual([]);
    expect(removedNetworks).toEqual([]);
    expect(deletedObjects).toEqual([]);
    expect(dropped).toEqual([]);
    // And says it did not look, rather than that it found nothing.
    expect(report.containers.skipped).toBeTruthy();
  });

  it('removes a container nothing claims', async () => {
    const { sweeper, destroyed } = build({ workloads: [workload()] });
    await sweeper.sweep();
    expect(destroyed).toEqual(['c-1']);
  });

  it('keeps a container its row still points at', async () => {
    const { sweeper, destroyed } = build({
      workloads: [workload()],
      runtimes: new Map([['r-1', 'c-1']]),
    });
    await sweeper.sweep();
    expect(destroyed).toEqual([]);
  });

  it('removes an earlier generation whose row now points at a different container', async () => {
    // A start that failed halfway and was retried: the row exists, and names a
    // newer container. This one is as abandoned as if the row were gone.
    const { sweeper, destroyed } = build({
      workloads: [workload()],
      runtimes: new Map([['r-1', 'c-2']]),
    });
    await sweeper.sweep();
    expect(destroyed).toEqual(['c-1']);
  });
});

describe('nothing young is touched', () => {
  it('leaves a container inside the grace period alone', async () => {
    const { sweeper, destroyed } = build({ workloads: [workload({ createdAt: young })] });
    await sweeper.sweep();
    expect(destroyed).toEqual([]);
  });

  it('treats a container of unknown age as young', async () => {
    const { sweeper, destroyed } = build({ workloads: [workload({ createdAt: undefined })] });
    await sweeper.sweep();
    expect(destroyed).toEqual([]);
  });

  it('leaves a recently stored object alone even with no row', async () => {
    const { sweeper, deletedObjects } = build({
      objects: [{ key: 'projects/p-1/new', size: 1, lastModified: young }],
    });
    await sweeper.sweep();
    expect(deletedObjects).toEqual([]);
  });
});

describe('what it will and will not remove', () => {
  it('leaves a container it cannot identify, rather than guessing', async () => {
    const { sweeper, destroyed } = build({
      workloads: [workload({ kind: 'unknown', workloadId: undefined })],
    });
    await sweeper.sweep();
    expect(destroyed).toEqual([]);
  });

  it('removes a network only when its project is gone and nothing is attached', async () => {
    const { sweeper, removedNetworks } = build({
      projects: new Set(['p-live']),
      networks: [
        { id: 'gone-empty', name: 'a', projectId: 'p-gone', attached: 0, createdAt: old },
        { id: 'gone-busy', name: 'b', projectId: 'p-gone', attached: 1, createdAt: old },
        { id: 'live-empty', name: 'c', projectId: 'p-live', attached: 0, createdAt: old },
      ],
    });
    await sweeper.sweep();
    expect(removedNetworks).toEqual(['gone-empty']);
  });

  it('drops a database with no row, and keeps one with a row', async () => {
    const { sweeper, dropped } = build({
      databases: [
        { name: 'p_orphan', role: 'r_orphan' },
        { name: 'p_kept', role: 'r_kept' },
      ],
      databaseNames: new Set(['p_kept']),
    });
    await sweeper.sweep();
    expect(dropped).toEqual(['p_orphan']);
  });

  it('removes an unreferenced object only under a prefix the platform owns', async () => {
    const { sweeper, deletedObjects } = build({
      objects: [
        { key: 'snapshots/p-1/orphan.tar', size: 1, lastModified: old },
        { key: 'someone-else/file', size: 1, lastModified: old },
      ],
    });
    await sweeper.sweep();
    expect(deletedObjects).toEqual(['snapshots/p-1/orphan.tar']);
  });
});

describe('a dry run', () => {
  it('reports what it would remove and removes nothing, in every step', async () => {
    const { sweeper, destroyed, removedNetworks, deletedObjects, dropped } = build({
      dryRun: true,
      workloads: [workload()],
      networks: [{ id: 'n', name: 'n', projectId: 'p-gone', attached: 0, createdAt: old }],
      objects: [{ key: 'snapshots/p/x.tar', size: 1, lastModified: old }],
      databases: [{ name: 'p_orphan', role: 'r_orphan' }],
    });

    const report = await sweeper.sweep();

    expect([destroyed, removedNetworks, deletedObjects, dropped]).toEqual([[], [], [], []]);
    expect(report.containers.orphaned).toBe(1);
    expect(report.networks.orphaned).toBe(1);
    expect(report.objects.orphaned).toBe(1);
    expect(report.databases.orphaned).toBe(1);
  });

  it('can be asked for per pass without changing what the timer does', async () => {
    const { sweeper, destroyed } = build({ workloads: [workload()] });
    await sweeper.sweepOnce({ dryRun: true });
    expect(destroyed).toEqual([]);
    await sweeper.sweep();
    expect(destroyed).toEqual(['c-1']);
  });
});
