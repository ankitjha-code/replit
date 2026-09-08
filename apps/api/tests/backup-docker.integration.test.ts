import { randomBytes, randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { pino } from 'pino';
import { afterAll, describe, expect, it } from 'vitest';
import {
  createDockerClient,
  DockerExecutionProvider,
} from '../src/execution/docker/docker-provider.js';
import { BackupRepository } from '../src/modules/databases/backup.repository.js';
import { BackupService } from '../src/modules/databases/backup.service.js';
import { MinioStorageProvider } from '../src/storage/minio-storage.js';
import { PostgresUserDatabaseProvider } from '../src/userdb/postgres-provider.js';
import { createTestClient, testDatabaseUrl } from './setup/database.js';

/**
 * A database copied and put back, with every real component.
 *
 * The project database server, a container running `pg_dump` on the project's
 * own network, MinIO holding the dump, and the platform database holding the
 * row. The one test the whole backup feature rests on: data in, copy, change,
 * restore, and the original data back.
 *
 * Requires `pnpm infra:up` and a running Docker daemon.
 */

const url = testDatabaseUrl();
const db = url ? createTestClient(url) : undefined;
const docker = createDockerClient(process.env.DOCKER_SOCKET_PATH);
const dockerUp = await docker
  .ping()
  .then(() => true)
  .catch(() => false);

const ADMIN_URL =
  process.env.USER_DATABASE_ADMIN_URL ??
  'postgresql://userdb_admin:userdb_dev_only@127.0.0.1:5452/postgres';
const log = pino({ level: 'silent' });
const PREFIX = `platform-backup-${process.pid}`;

const execution = new DockerExecutionProvider(
  docker,
  {
    workspacePath: '/workspace',
    networkPrefix: PREFIX,
    publishMode: 'never',
    terminalReplayBytes: 1024,
    // So the dump container can reach the project database by name.
    sharedServiceContainer: 'platform-userdb',
    hardening: {
      // Set TEST_OCI_RUNTIME=runsc to run this suite under gVisor.
      ociRuntime: process.env.TEST_OCI_RUNTIME ?? null,
      maxOpenFiles: 4_096,
      maxProcesses: 128,
      workloadUser: '1000:1000',
      homePath: '/home/workload',
      tmpMegabytes: 64,
    },
    pullTimeoutMs: 600_000,
    availabilityTtlMs: 0,
    read: { maxFileBytes: 50e6, maxTotalBytes: 50e6, maxFiles: 1_000, applyExclusions: false },
    collect: { maxFileBytes: 50e6, maxTotalBytes: 50e6, maxFiles: 1_000, applyExclusions: false },
  },
  log,
);

const storage = new MinioStorageProvider(
  {
    endpoint: process.env.STORAGE_ENDPOINT ?? 'http://localhost:9100',
    bucket: process.env.STORAGE_BUCKET ?? 'platform-assets',
    accessKey: process.env.STORAGE_ACCESS_KEY ?? 'platform',
    secretKey: process.env.STORAGE_SECRET_KEY ?? 'platform_dev_only',
    availabilityTtlMs: 0,
  },
  log,
);

const userDatabases = new PostgresUserDatabaseProvider(
  { adminUrl: ADMIN_URL, availabilityTtlMs: 0 },
  log,
);

const serverUp = await (async () => {
  const client = new Client({ connectionString: ADMIN_URL, connectionTimeoutMillis: 2_000 });
  try {
    await client.connect();
    await client.end();
    return true;
  } catch {
    return false;
  }
})();

const hex = randomUUID().replaceAll('-', '');
const spec = {
  name: `p_${hex}`,
  role: `r_${hex}`,
  password: randomBytes(18).toString('base64url'),
};

afterAll(async () => {
  await userDatabases.drop(spec).catch(() => undefined);
  for (const network of await execution.listNetworks().catch(() => [])) {
    if (network.name.startsWith(PREFIX))
      await execution.removeNetwork(network.id).catch(() => undefined);
  }
  await db?.$disconnect();
});

/** Talks to the project database directly, the way its own application would. */
async function query<T>(sql: string): Promise<T[]> {
  const direct = new URL(ADMIN_URL);
  direct.username = spec.role;
  direct.password = spec.password;
  direct.pathname = `/${spec.name}`;
  const client = new Client({ connectionString: direct.toString() });
  await client.connect();
  try {
    return (await client.query(sql)).rows as T[];
  } finally {
    await client.end();
  }
}

// Needs the development stack's `platform-userdb` container on the same
// daemon, which a separate gVisor test daemon does not have.
describe.skipIf(!db || !dockerUp || !serverUp || Boolean(process.env.DOCKER_HOST))(
  'backing up and restoring a project database',
  () => {
    it('puts back exactly what was there when the copy was taken', async () => {
      // The platform's own rows the backup hangs off.
      const user = await db!.user.create({
        data: {
          email: `b-${hex}@example.test`,
          username: `b${hex.slice(0, 20)}`,
          passwordHash: 'x',
        },
      });
      const project = await db!.project.create({
        data: {
          slug: `b-${hex.slice(0, 12)}`,
          name: 'Backup test',
          ownerId: user.id,
          members: { create: { userId: user.id, role: 'OWNER' } },
        },
      });
      const record = await db!.projectDatabase.create({
        data: {
          projectId: project.id,
          name: spec.name,
          role: spec.role,
          password: Buffer.from('unused'),
          status: 'READY',
        },
      });

      await userDatabases.provision(spec);
      await query('CREATE TABLE ledger (id int PRIMARY KEY, note text)');
      await query(`INSERT INTO ledger VALUES (1, 'first'), (2, 'second'), (3, 'third')`);

      const service = new BackupService(
        new BackupRepository(db!),
        execution,
        storage,
        {
          image: 'postgres:17-alpine',
          timeoutMs: 300_000,
          maxPerProject: 5,
          listLimit: 10,
          limits: { cpuMillicores: 1_000, memoryMb: 512, pidsLimit: 256 },
        },
        log,
      );

      // As a workload on the project's network sees it: by container name.
      const connectionUrl = `postgresql://${spec.role}:${spec.password}@platform-userdb:5432/${spec.name}`;

      const backup = await service.create(
        project.id,
        { databaseId: record.id, connectionUrl },
        user.id,
        { note: 'before the mistake' },
      );
      expect(backup.status).toBe('READY');
      expect(backup.sizeBytes).toBeGreaterThan(0);

      // The mistake.
      await query('DELETE FROM ledger');
      await query(`INSERT INTO ledger VALUES (99, 'wrong')`);

      await service.restore(project.id, backup.id, connectionUrl);

      const rows = await query<{ id: number; note: string }>(
        'SELECT id, note FROM ledger ORDER BY id',
      );
      expect(rows).toEqual([
        { id: 1, note: 'first' },
        { id: 2, note: 'second' },
        { id: 3, note: 'third' },
      ]);

      // And the workloads that held a copy of somebody's data are gone.
      const leftovers = await execution.listWorkloads();
      expect(leftovers.filter((w) => w.projectId === project.id)).toEqual([]);

      // Deleting the project's backups removes the dump from storage too.
      await service.releaseProject(project.id);
      const stored = await storage.list(`database-backups/${project.id}/`);
      expect(stored).toEqual([]);
    }, 600_000);
  },
);
