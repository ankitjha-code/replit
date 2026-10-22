import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import type { MetricsRepository } from './metrics.repository.js';

export class MetricsService {
  readonly registry = new Registry();

  private readonly requests = new Counter({
    name: 'platform_http_requests_total',
    help: 'HTTP requests handled by the API, by route pattern, method and status.',
    labelNames: ['method', 'route', 'status'] as const,
    registers: [this.registry],
  });

  private readonly durations = new Histogram({
    name: 'platform_http_request_duration_seconds',
    help: 'How long API requests took, by route pattern and method.',
    labelNames: ['method', 'route'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [this.registry],
  });

  private openSockets: () => number = () => 0;

  constructor(private readonly counts: MetricsRepository | undefined) {
    collectDefaultMetrics({ register: this.registry, prefix: 'platform_' });

    const counts_ = this.counts;
    let latest: Awaited<ReturnType<MetricsRepository['counts']>> | undefined;
    let pending: Promise<void> | undefined;
    const refresh = async (): Promise<void> => {
      if (!counts_) return;
      pending ??= counts_
        .counts()
        .then((value) => {
          latest = value;
        })
        .finally(() => {
          setTimeout(() => (pending = undefined), 1_000).unref();
        });
      await pending;
    };

    new Gauge({
      name: 'platform_users',
      help: 'Accounts that exist.',
      registers: [this.registry],
      async collect() {
        await refresh();
        if (latest) this.set(latest.users);
      },
    });
    new Gauge({
      name: 'platform_projects',
      help: 'Projects that exist.',
      registers: [this.registry],
      async collect() {
        await refresh();
        if (latest) this.set(latest.projects);
      },
    });
    new Gauge({
      name: 'platform_runtimes',
      help: 'Development environments, by status.',
      labelNames: ['status'] as const,
      registers: [this.registry],
      async collect() {
        await refresh();
        this.reset();
        for (const row of latest?.runtimes ?? []) this.set({ status: row.status }, row.count);
      },
    });
    new Gauge({
      name: 'platform_deployments',
      help: 'Deployments, by status.',
      labelNames: ['status'] as const,
      registers: [this.registry],
      async collect() {
        await refresh();
        this.reset();
        for (const row of latest?.deployments ?? []) this.set({ status: row.status }, row.count);
      },
    });
    new Gauge({
      name: 'platform_jobs',
      help: 'Background jobs, by status and type.',
      labelNames: ['status', 'type'] as const,
      registers: [this.registry],
      async collect() {
        await refresh();
        this.reset();
        for (const row of latest?.jobs ?? []) {
          this.set({ status: row.status, type: row.type }, row.count);
        }
      },
    });
    const sockets = () => this.openSockets();
    new Gauge({
      name: 'platform_websockets_open',
      help: 'WebSocket connections open on this process, across every gateway.',
      registers: [this.registry],
      collect() {
        this.set(sockets());
      },
    });
  }

  useSocketCount(count: () => number): void {
    this.openSockets = count;
  }

  middleware() {
    return (req: Request, res: Response, next: NextFunction): void => {
      const end = this.durations.startTimer();
      res.on('finish', () => {
        const route = routeOf(req);
        const labels = { method: req.method, route };
        end(labels);
        this.requests.inc({ ...labels, status: String(res.statusCode) });
      });
      next();
    };
  }

  handler(token: string | undefined) {
    return async (req: Request, res: Response): Promise<void> => {
      if (!token || !matches(req.get('authorization'), `Bearer ${token}`)) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Not found' } });
        return;
      }
      res.set('Content-Type', this.registry.contentType);
      res.set('Cache-Control', 'no-store');
      res.send(await this.registry.metrics());
    };
  }
}

function routeOf(req: Request): string {
  const pattern = (req.route as { path?: unknown } | undefined)?.path;
  if (typeof pattern === 'string') return `${req.baseUrl}${pattern}`;
  return 'unmatched';
}

function matches(given: string | undefined, expected: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
