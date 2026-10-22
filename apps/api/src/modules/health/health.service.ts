import type { DependencyHealth, HealthResponse, PublicHealthResponse } from '@platform/shared';

export interface DependencyProbe {
  readonly name: string;
  check(): Promise<Omit<DependencyHealth, 'name' | 'latencyMs'>>;
}

const PROBE_TIMEOUT_MS = 2_000;

export class HealthService {
  private readonly probes = new Map<string, DependencyProbe>();
  private cached: { dependencies: DependencyHealth[]; at: number } | undefined;
  private inFlight: Promise<DependencyHealth[]> | undefined;

  constructor(
    private readonly serviceName: string,
    private readonly version: string,
    private readonly startedAt: number = Date.now(),
    private readonly cacheMs = 0,
  ) {}

  register(probe: DependencyProbe): void {
    this.probes.set(probe.name, probe);
    this.cached = undefined;
  }

  unregister(name: string): void {
    this.probes.delete(name);
    this.cached = undefined;
  }

  live(): Pick<HealthResponse, 'status' | 'service'> {
    return { status: 'ok', service: this.serviceName };
  }

  async ready(): Promise<HealthResponse> {
    const dependencies = await this.probeAll();

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

  private async probeAll(): Promise<DependencyHealth[]> {
    const cached = this.cached;
    if (this.cacheMs > 0 && cached && Date.now() - cached.at < this.cacheMs) {
      return cached.dependencies;
    }
    if (this.inFlight) return this.inFlight;

    const round = Promise.all([...this.probes.values()].map((probe) => this.runProbe(probe)));
    this.inFlight = round;
    try {
      const dependencies = await round;
      this.cached = { dependencies, at: Date.now() };
      return dependencies;
    } finally {
      this.inFlight = undefined;
    }
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

export function publicReadiness(report: HealthResponse): PublicHealthResponse {
  return {
    status: report.status,
    dependencies: report.dependencies.map(({ name, status }) => ({ name, status })),
  };
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
