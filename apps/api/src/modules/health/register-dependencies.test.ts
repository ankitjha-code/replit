import { describe, expect, it } from 'vitest';
import { loadEnv } from '../../config/env.js';
import { HealthService } from './health.service.js';
import { registerInfrastructureProbes } from './register-dependencies.js';

const names = async (source: NodeJS.ProcessEnv): Promise<string[]> => {
  const health = new HealthService('api', '0.0.0');
  registerInfrastructureProbes(health, loadEnv(source));
  return (await health.ready()).dependencies.map((d) => d.name).sort();
};

describe('infrastructure probe registration', () => {
  it('registers nothing when nothing is configured', async () => {
    await expect(names({} as NodeJS.ProcessEnv)).resolves.toEqual([]);
  });

  it('registers a database probe when a URL is set', async () => {
    await expect(
      names({ DATABASE_URL: 'postgresql://u:p@127.0.0.1:1/db' } as NodeJS.ProcessEnv),
    ).resolves.toEqual(['postgres']);
  });

  it('treats an empty value as unconfigured', async () => {
    await expect(
      names({ DATABASE_URL: '', REDIS_URL: '   ' } as NodeJS.ProcessEnv),
    ).resolves.toEqual([]);
  });

  it('does not register Redis until it is configured', async () => {
    const withRedis = await names({ REDIS_URL: 'redis://127.0.0.1:1' } as NodeJS.ProcessEnv);
    expect(withRedis).toEqual(['redis']);
  });

  it('registers storage from its endpoint', async () => {
    await expect(
      names({ STORAGE_ENDPOINT: 'http://127.0.0.1:1' } as NodeJS.ProcessEnv),
    ).resolves.toEqual(['storage']);
  });

  it('registers every configured dependency together', async () => {
    await expect(
      names({
        DATABASE_URL: 'postgresql://u:p@127.0.0.1:1/db',
        REDIS_URL: 'redis://127.0.0.1:1',
        STORAGE_ENDPOINT: 'http://127.0.0.1:1',
      } as NodeJS.ProcessEnv),
    ).resolves.toEqual(['postgres', 'redis', 'storage']);
  });

  it('rejects a database URL that is not a postgres URL', () => {
    expect(() => loadEnv({ DATABASE_URL: 'mysql://x/y' } as NodeJS.ProcessEnv)).toThrow(
      /Invalid environment configuration/,
    );
  });

  it('does not name the connection URL in the validation failure', () => {
    try {
      loadEnv({ DATABASE_URL: 'mysql://user:hunter2@host/db' } as NodeJS.ProcessEnv);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(String(error)).not.toContain('hunter2');
    }
  });
});

describe('database probe selection', () => {
  it('registers a TCP probe only when no client was built', async () => {
    const health = new HealthService('api', '0.0.0');
    registerInfrastructureProbes(
      health,
      loadEnv({ DATABASE_URL: 'postgresql://u:p@127.0.0.1:1/db' } as NodeJS.ProcessEnv),
      false,
    );
    expect((await health.ready()).dependencies.map((d) => d.name)).toEqual(['postgres']);
  });

  it('leaves the database to the query probe when a client exists', async () => {
    // Otherwise readiness would report postgres twice, once weakly.
    const health = new HealthService('api', '0.0.0');
    registerInfrastructureProbes(
      health,
      loadEnv({ DATABASE_URL: 'postgresql://u:p@127.0.0.1:1/db' } as NodeJS.ProcessEnv),
      true,
    );
    expect((await health.ready()).dependencies).toEqual([]);
  });
});
