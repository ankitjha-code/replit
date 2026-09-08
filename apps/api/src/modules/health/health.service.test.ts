import { describe, expect, it } from 'vitest';
import { HealthService, type DependencyProbe } from './health.service.js';

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
    expect(service.live().status).toBe('ok');
    expect(service.live().version).toBe('1.2.3');
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
});
