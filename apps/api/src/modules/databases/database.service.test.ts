import { describe, expect, it, vi } from 'vitest';
import { createSecretBox } from '../../lib/secret-box.js';
import type { UserDatabaseProvider, UserDatabaseSpec } from '../../userdb/provider.js';
import { UnavailableUserDatabaseProvider } from '../../userdb/unavailable-provider.js';
import type { SecretRepository } from '../secrets/secret.repository.js';
import type { VariableRepository } from '../variables/variable.repository.js';
import type { DatabaseRecord, DatabaseRepository } from './database.repository.js';
import { DatabaseService } from './database.service.js';

/**
 * The rules around a project's database, without a PostgreSQL server.
 *
 * The integration suite proves the credential works and reaches nothing else.
 * These cover the decisions: what happens when provisioning fails halfway, what
 * an application is told, and what the platform refuses to do.
 */

const KEY = Buffer.alloc(32, 7);

/** A provider that records what it was asked and can be made to fail. */
class RecordingProvider implements UserDatabaseProvider {
  /** Nothing is really provisioned here, so cleanup would find nothing. */
  list(): Promise<{ name: string; role: string | null }[]> {
    return Promise.resolve([]);
  }

  readonly name = 'recording';
  readonly provisioned: UserDatabaseSpec[] = [];
  readonly dropped: { name: string; role: string }[] = [];
  readonly resets: { name: string; role: string }[] = [];
  readonly passwords: string[] = [];
  reason: string | null = null;
  failProvision = false;

  unavailableReason(): Promise<string | null> {
    return Promise.resolve(this.reason);
  }
  provision(spec: UserDatabaseSpec): Promise<void> {
    if (this.failProvision) return Promise.reject(new Error('server said no'));
    this.provisioned.push(spec);
    return Promise.resolve();
  }
  setPassword(_role: string, password: string): Promise<void> {
    this.passwords.push(password);
    return Promise.resolve();
  }
  reset(spec: { name: string; role: string }): Promise<void> {
    this.resets.push(spec);
    return Promise.resolve();
  }
  sizeOf(): Promise<number | null> {
    return Promise.resolve(4096);
  }
  drop(spec: { name: string; role: string }): Promise<void> {
    this.dropped.push(spec);
    return Promise.resolve();
  }
}

const PROJECT = '018f0000-0000-7000-8000-0000000000aa';

function build(options: { provider?: UserDatabaseProvider; noKey?: boolean } = {}) {
  const rows = new Map<string, DatabaseRecord>();
  let sequence = 0;

  const databases = {
    findByProject: (projectId: string) => Promise.resolve(rows.get(projectId) ?? null),
    create: (input: { projectId: string; name: string; role: string; password: Buffer }) => {
      sequence += 1;
      const record: DatabaseRecord = {
        id: `db-${sequence}`,
        projectId: input.projectId,
        status: 'CREATING',
        name: input.name,
        role: input.role,
        password: Uint8Array.from(input.password),
        message: null,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      };
      rows.set(input.projectId, record);
      return Promise.resolve(record);
    },
    markReady: (id: string) => {
      for (const record of rows.values()) {
        if (record.id === id) record.status = 'READY';
      }
      return Promise.resolve([...rows.values()].find((r) => r.id === id)!);
    },
    markFailed: (id: string, message: string) => {
      for (const record of rows.values()) {
        if (record.id === id) {
          record.status = 'FAILED';
          record.message = message;
        }
      }
      return Promise.resolve([...rows.values()].find((r) => r.id === id)!);
    },
    setPassword: () => Promise.reject(new Error('not used here')),
    deleteByProject: (projectId: string) => {
      rows.delete(projectId);
      return Promise.resolve();
    },
  } as unknown as DatabaseRepository;

  const variables = {
    keysForProject: () => Promise.resolve([] as string[]),
  } as unknown as VariableRepository;

  const secrets = {
    listForProject: () => Promise.resolve([] as { key: string }[]),
  } as unknown as SecretRepository;

  const provider = options.provider ?? new RecordingProvider();

  const service = new DatabaseService(
    databases,
    provider,
    options.noKey ? undefined : createSecretBox(KEY),
    variables,
    secrets,
    { containerHost: 'platform-userdb', containerPort: 5432 },
    { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
  );

  return { service, provider, rows };
}

describe('provisioning', () => {
  it('records it ready once the server made it', async () => {
    const { service } = build();
    const state = await service.provision(PROJECT);
    expect(state.database?.status).toBe('READY');
  });

  it('derives names from the project, never from anything typed', async () => {
    const { service, provider } = build();
    await service.provision(PROJECT);

    const spec = (provider as RecordingProvider).provisioned[0]!;
    expect(spec.name).toBe('p_018f00000000700080000000000000aa');
    expect(spec.role).toBe('r_018f00000000700080000000000000aa');
  });

  it('generates a password that needs no escaping in SQL or a URL', async () => {
    const { service, provider } = build();
    await service.provision(PROJECT);

    const spec = (provider as RecordingProvider).provisioned[0]!;
    expect(spec.password).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
  });

  it('refuses a second database rather than replacing the first', async () => {
    const { service } = build();
    await service.provision(PROJECT);
    await expect(service.provision(PROJECT)).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});

describe('when the server refuses', () => {
  it('records the failure rather than claiming success', async () => {
    const provider = new RecordingProvider();
    provider.failProvision = true;
    const { service, rows } = build({ provider });

    await expect(service.provision(PROJECT)).rejects.toMatchObject({ code: 'EXECUTION_FAILED' });
    expect(rows.get(PROJECT)?.status).toBe('FAILED');
  });

  it('undoes whatever did get made', async () => {
    // Provisioning is several statements and cannot be atomic at the server, so
    // a failure halfway leaves a role with no database or the reverse.
    const provider = new RecordingProvider();
    provider.failProvision = true;
    const { service } = build({ provider });

    await service.provision(PROJECT).catch(() => undefined);
    expect(provider.dropped).toHaveLength(1);
  });

  it('lets a failed attempt be retried', async () => {
    const provider = new RecordingProvider();
    provider.failProvision = true;
    const { service } = build({ provider });
    await service.provision(PROJECT).catch(() => undefined);

    provider.failProvision = false;
    const state = await service.provision(PROJECT);
    expect(state.database?.status).toBe('READY');
  });

  it('writes nothing at all when the server is simply absent', async () => {
    const { service, rows } = build({ provider: new UnavailableUserDatabaseProvider() });

    await expect(service.provision(PROJECT)).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
    });
    expect(rows.size).toBe(0);
  });

  it('refuses when there is no key to encrypt the credential with', async () => {
    const { service } = build({ noKey: true });
    await expect(service.provision(PROJECT)).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
    });
  });
});

describe('who is shown the credential', () => {
  it('includes it when the caller was allowed it', async () => {
    const { service } = build();
    await service.provision(PROJECT);

    const state = await service.describe(PROJECT, { includeConnection: true });
    expect(state.database?.connection?.password).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('omits it when the caller was not', async () => {
    // The service is told rather than deciding by inspecting a role: the route
    // that already ran an authorization check is what knows.
    const { service } = build();
    await service.provision(PROJECT);

    const state = await service.describe(PROJECT, { includeConnection: false });
    expect(state.database?.connection).toBeNull();
    expect(state.database?.status).toBe('READY');
  });
});

describe('what the application is told', () => {
  it('gets the whole family, so libraries and command line tools both work', async () => {
    const { service } = build();
    await service.provision(PROJECT);

    const env = await service.forRuntime(PROJECT);
    expect(Object.keys(env).sort()).toEqual([
      'DATABASE_URL',
      'PGDATABASE',
      'PGHOST',
      'PGPASSWORD',
      'PGPORT',
      'PGUSER',
    ]);
  });

  it('is pointed at the container host, not the platform loopback', async () => {
    const { service } = build();
    await service.provision(PROJECT);

    const env = await service.forRuntime(PROJECT);
    expect(env.PGHOST).toBe('platform-userdb');
    expect(env.DATABASE_URL).toContain('@platform-userdb:5432/');
  });

  it('is told nothing when there is no database', async () => {
    const { service } = build();
    expect(await service.forRuntime(PROJECT)).toEqual({});
  });

  it('is told nothing about a database that failed to be made', async () => {
    // A connection string that does not work is worse than none: the
    // application reports a connection failure and nobody knows why.
    const provider = new RecordingProvider();
    provider.failProvision = true;
    const { service } = build({ provider });
    await service.provision(PROJECT).catch(() => undefined);

    expect(await service.forRuntime(PROJECT)).toEqual({});
  });
});

describe('releasing', () => {
  it('drops the database and forgets the row', async () => {
    const { service, provider, rows } = build();
    await service.provision(PROJECT);

    await service.release(PROJECT);

    expect((provider as RecordingProvider).dropped).toHaveLength(1);
    expect(rows.size).toBe(0);
  });

  it('is a no-op for a project that never had one', async () => {
    const { service, provider } = build();
    await service.release(PROJECT);
    expect((provider as RecordingProvider).dropped).toHaveLength(0);
  });

  it('still forgets the row when the server cannot be reached', async () => {
    /*
     * A project must stay deletable when the database server is down.
     *
     * The database is then orphaned, which is recorded as a leak rather than
     * turned into a project nobody can remove.
     */
    const provider = new RecordingProvider();
    provider.drop = () => Promise.reject(new Error('unreachable'));
    const { service, rows } = build({ provider });
    await service.provision(PROJECT);

    await expect(service.release(PROJECT)).resolves.toBeUndefined();
    expect(rows.size).toBe(0);
  });
});
