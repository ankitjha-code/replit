import { describe, expect, it } from 'vitest';
import { HealthService, publicReadiness, type DependencyProbe } from './health.service.js';

const probe = (
  name: string,
  status: 'up' | 'down' | 'unknown',
  behaviour: 'resolve' | 'reject' | 'hang' = 'resolve',
): DependencyProbe => ({
  name,
  check: () => {
    if (behaviour === 'reject') return Promise.reject(new Error('connection refused'));
    if (behaviour === 'hang') return new Promise(() => {});
    return Promise.resolve({ status });
  },
});

describe('HealthService', () => {
  it('reports liveness without touching dependencies', () => {
    const service = new HealthService('api', '1.2.3');
    service.register(probe('db', 'down', 'reject'));
    expect(service.live()).toEqual({ status: 'ok', service: 'api' });
  });

  it('reports no dependencies when none are registered', async () => {
    const report = await new HealthService('api', '0.1.0').ready();
    expect(report.dependencies).toEqual([]);
    expect(report.status).toBe('ok');
  });

  it('is ok when every dependency is up', async () => {
    const service = new HealthService('api', '0.1.0');
    service.register(probe('db', 'up'));
    service.register(probe('cache', 'up'));
    const report = await service.ready();
    expect(report.status).toBe('ok');
    expect(report.dependencies.map((d) => d.name).sort()).toEqual(['cache', 'db']);
  });

  it('is down when any dependency is down', async () => {
    const service = new HealthService('api', '0.1.0');
    service.register(probe('db', 'up'));
    service.register(probe('storage', 'down'));
    expect((await service.ready()).status).toBe('down');
  });

  it('is degraded when a dependency is unknown but none are down', async () => {
    const service = new HealthService('api', '0.1.0');
    service.register(probe('queue', 'unknown'));
    expect((await service.ready()).status).toBe('degraded');
  });

  it('treats a throwing probe as down and records the reason', async () => {
    const service = new HealthService('api', '0.1.0');
    service.register(probe('db', 'up', 'reject'));
    const report = await service.ready();
    expect(report.dependencies[0]?.status).toBe('down');
    expect(report.dependencies[0]?.detail).toContain('connection refused');
  });

  it('measures probe latency', async () => {
    const service = new HealthService('api', '0.1.0');
    service.register(probe('db', 'up'));
    expect((await service.ready()).dependencies[0]?.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('drops a probe once unregistered', async () => {
    const service = new HealthService('api', '0.1.0');
    service.register(probe('db', 'down'));
    service.unregister('db');
    expect((await service.ready()).status).toBe('ok');
  });
  it('answers from the last round of probes while it is fresh', async () => {
    let calls = 0;
    const service = new HealthService('api', '0.1.0', Date.now(), 60_000);
    service.register({ name: 'db', check: () => (calls++, Promise.resolve({ status: 'up' })) });

    await service.ready();
    await service.ready();
    expect(calls).toBe(1);
  });

  it('probes again once the cached round is older than the cache', async () => {
    let calls = 0;
    const service = new HealthService('api', '0.1.0', Date.now(), 1);
    service.register({ name: 'db', check: () => (calls++, Promise.resolve({ status: 'up' })) });

    await service.ready();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await service.ready();
    expect(calls).toBe(2);
  });

  it('shares one round between concurrent callers', async () => {
    let calls = 0;
    const service = new HealthService('api', '0.1.0', Date.now(), 60_000);
    service.register({ name: 'db', check: () => (calls++, Promise.resolve({ status: 'up' })) });

    await Promise.all([service.ready(), service.ready(), service.ready()]);
    expect(calls).toBe(1);
  });

  it('forgets the cached round when the set of probes changes', async () => {
    const service = new HealthService('api', '0.1.0', Date.now(), 60_000);
    service.register(probe('db', 'up'));
    await service.ready();

    service.register(probe('storage', 'down'));
    expect((await service.ready()).status).toBe('down');
  });

  it('keeps uptime current even when the probes are cached', async () => {
    const service = new HealthService('api', '0.1.0', Date.now() - 5_000, 60_000);
    expect((await service.ready()).uptimeSeconds).toBeGreaterThanOrEqual(5);
  });
});

describe('publicReadiness', () => {
  it('keeps names and verdicts and drops everything a stranger should not see', async () => {
    const service = new HealthService('api', '9.9.9');
    service.register({
      name: 'redis',
      check: () => Promise.resolve({ status: 'up', detail: 'tcp 172.31.251.12:6379 accepting' }),
    });
    service.register(probe('mail', 'up', 'reject'));

    const shown = publicReadiness(await service.ready());

    expect(shown).toEqual({
      status: 'down',
      dependencies: [
        { name: 'redis', status: 'up' },
        { name: 'mail', status: 'down' },
      ],
    });
    expect(JSON.stringify(shown)).not.toMatch(/172\.31|9\.9\.9|connection refused|latency/);
  });
});
