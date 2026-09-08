import type { DependencyHealth, HealthResponse } from '@platform/shared';

/**
 * A probe answers whether one dependency is reachable.
 *
 * Infrastructure registers its own probe as it is introduced (database, cache,
 * object storage, execution host). Nothing is reported that is not actually
 * measured, so an empty registry yields an empty dependency list rather than a
 * fabricated green tick.
 */
export interface DependencyProbe {
  readonly name: string;
  check(): Promise<Omit<DependencyHealth, 'name' | 'latencyMs'>>;
}

const PROBE_TIMEOUT_MS = 2_000;

export class HealthService {
  private readonly probes = new Map<string, DependencyProbe>();

  constructor(
    private readonly serviceName: string,
    private readonly version: string,
    private readonly startedAt: number = Date.now(),
  ) {}

  register(probe: DependencyProbe): void {
    this.probes.set(probe.name, probe);
  }

  unregister(name: string): void {
    this.probes.delete(name);
  }

  /** Process is up. Never touches dependencies, so it stays cheap. */
  live(): Pick<HealthResponse, 'status' | 'service' | 'version' | 'uptimeSeconds'> {
    return {
      status: 'ok',
      service: this.serviceName,
      version: this.version,
      uptimeSeconds: this.uptimeSeconds(),
    };
  }

  /** Process is up and every registered dependency answered. */
  async ready(): Promise<HealthResponse> {
    const dependencies = await Promise.all(
      [...this.probes.values()].map((probe) => this.runProbe(probe)),
    );

    const down = dependencies.filter((d) => d.status === 'down').length;
    const unknown = dependencies.filter((d) => d.status === 'unknown').length;

    return {
      status: down > 0 ? 'down' : unknown > 0 ? 'degraded' : 'ok',
      service: this.serviceName,
      version: this.version,
      uptimeSeconds: this.uptimeSeconds(),
      dependencies,
    };
  }

  private uptimeSeconds(): number {
    return Math.floor((Date.now() - this.startedAt) / 1000);
  }

  private async runProbe(probe: DependencyProbe): Promise<DependencyHealth> {
    const start = Date.now();
    try {
      const result = await withTimeout(probe.check(), PROBE_TIMEOUT_MS);
      return { name: probe.name, latencyMs: Date.now() - start, ...result };
    } catch (error) {
      return {
        name: probe.name,
        latencyMs: Date.now() - start,
        status: 'down',
        detail: error instanceof Error ? error.message : 'Probe failed',
      };
    }
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Probe timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
