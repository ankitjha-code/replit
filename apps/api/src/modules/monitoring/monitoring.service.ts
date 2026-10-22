import {
  healthCheckPathSchema,
  type ApplicationHealth,
  type HealthCheckConfig,
  type MonitoringResponse,
  type WatchedWorkload,
  type WorkloadUsage,
} from '@platform/shared';
import type { Logger } from 'pino';
import { AppError } from '../../errors/app-error.js';
import type { ExecutionProvider } from '../../execution/provider.js';
import { probeApplication } from '../../lib/probes/application.js';
import type { DeploymentRepository } from '../deployments/deployment.repository.js';
import type { ServingDeployment } from '../deployments/deployment.service.js';
import type { RuntimeRepository } from '../runtimes/runtime.repository.js';
import { UsageWindows } from './usage-window.js';

export interface MonitoringServiceOptions {
  sampleIntervalMs: number;
  historySamples: number;
  defaultHealthPath: string;
  defaultHealthTimeoutMs: number;
}

interface PreviewTargets {
  target(projectId: string): Promise<{ host: string; port: number } | undefined>;
}

interface ServingDeployments {
  serving(projectId: string): Promise<ServingDeployment | null>;
}

interface HealthCheckStore {
  read(projectId: string): Promise<{ path: string | null; timeoutMs: number | null } | null>;
  write(projectId: string, input: { path: string; timeoutMs: number }): Promise<void>;
}

export class MonitoringService {
  private readonly windows: UsageWindows;

  private readonly lastSampled = new Map<string, number>();

  constructor(
    private readonly runtimes: RuntimeRepository,
    private readonly deployments: DeploymentRepository,
    private readonly execution: ExecutionProvider,
    private readonly previews: PreviewTargets,
    private readonly serving: ServingDeployments,
    private readonly settings: HealthCheckStore,
    private readonly options: MonitoringServiceOptions,
    private readonly log: Logger,
  ) {
    this.windows = new UsageWindows(options.historySamples);
  }

  async describe(projectId: string): Promise<MonitoringResponse> {
    const unavailableReason = await this.execution.unavailableReason();
    const healthCheck = await this.healthCheck(projectId);

    const workloads = unavailableReason
      ? []
      : [
          ...(await this.describeRuntime(projectId, healthCheck)),
          ...(await this.describeDeployments(projectId, healthCheck)),
        ];

    this.windows.retain(workloads.map((workload) => workload.id));

    return {
      workloads,
      healthCheck,
      unavailableReason,
      historySeconds: Math.round(
        (this.options.historySamples * this.options.sampleIntervalMs) / 1000,
      ),
      sampleIntervalSeconds: Math.max(Math.round(this.options.sampleIntervalMs / 1000), 1),
    };
  }

  async deploymentReading(projectId: string): Promise<WatchedWorkload | null> {
    if (await this.execution.unavailableReason()) return null;
    const [workload] = await this.describeDeployments(projectId, await this.healthCheck(projectId));
    return workload ?? null;
  }

  async healthCheck(projectId: string): Promise<HealthCheckConfig> {
    const stored = await this.settings.read(projectId);

    return {
      path: stored?.path ?? this.options.defaultHealthPath,
      timeoutMs: stored?.timeoutMs ?? this.options.defaultHealthTimeoutMs,
    };
  }

  async setHealthCheck(
    projectId: string,
    input: { path: string; timeoutMs?: number | undefined },
  ): Promise<HealthCheckConfig> {
    const result = healthCheckPathSchema.safeParse(input.path);

    if (!result.success) {
      throw new AppError('VALIDATION_FAILED', 'That path cannot be used', {
        details: {
          fields: [{ path: 'path', message: result.error.issues[0]?.message ?? 'Invalid path' }],
        },
      });
    }

    const timeoutMs = input.timeoutMs ?? this.options.defaultHealthTimeoutMs;

    await this.settings.write(projectId, { path: result.data, timeoutMs });
    this.log.info({ projectId, path: result.data }, 'health check changed');

    return { path: result.data, timeoutMs };
  }

  private async describeRuntime(
    projectId: string,
    check: HealthCheckConfig,
  ): Promise<WatchedWorkload[]> {
    const record = await this.runtimes.findByProject(projectId);

    if (!record || record.status !== 'RUNNING' || !record.externalId) return [];

    const usage = await this.sample(record.id, record.externalId, {
      cpuLimitMillicores: record.cpuMillicores,
      memoryLimitBytes: record.memoryMb * 1024 * 1024,
      pidsLimit: record.pidsLimit,
    });

    const target = await this.previews.target(projectId);

    return [
      {
        kind: 'RUNTIME',
        id: record.id,
        label: `${record.language} ${record.version}`,
        usage,
        history: this.windows.read(record.id),
        health: target
          ? await this.probe(target, check)
          : unknownHealth('Nothing is listening in this environment yet.'),
      },
    ];
  }

  private async describeDeployments(
    projectId: string,
    check: HealthCheckConfig,
  ): Promise<WatchedWorkload[]> {
    const record = await this.deployments.findServing(projectId);
    if (!record) return [];

    const label = record.note ?? (record.target === 'STATIC' ? 'Static site' : 'Server');

    if (record.target === 'STATIC') {
      const serving = await this.serving.serving(projectId);

      return [
        {
          kind: 'DEPLOYMENT',
          id: record.id,
          label,
          usage: null,
          history: [],
          health:
            serving?.kind === 'static'
              ? {
                  state: 'healthy',
                  statusCode: null,
                  latencyMs: null,
                  checkedAt: new Date().toISOString(),
                  message: 'Served by the platform from stored files.',
                }
              : unknownHealth('The stored files for this deployment could not be found.'),
        },
      ];
    }

    if (!record.externalId) return [];

    const usage = await this.sample(record.id, record.externalId, {
      cpuLimitMillicores: this.deploymentLimits.cpuMillicores,
      memoryLimitBytes: this.deploymentLimits.memoryMb * 1024 * 1024,
      pidsLimit: this.deploymentLimits.pidsLimit,
    });

    const serving = await this.serving.serving(projectId);

    return [
      {
        kind: 'DEPLOYMENT',
        id: record.id,
        label,
        usage,
        history: this.windows.read(record.id),
        health:
          serving?.kind === 'server'
            ? await this.probe(serving.target, check)
            : unknownHealth('This deployment is not reachable from the platform.'),
      },
    ];
  }

  private deploymentLimits = { cpuMillicores: 1_000, memoryMb: 512, pidsLimit: 256 };

  useDeploymentLimits(limits: {
    cpuMillicores: number;
    memoryMb: number;
    pidsLimit: number;
  }): void {
    this.deploymentLimits = limits;
  }

  private async sample(
    workloadId: string,
    externalId: string,
    limits: { cpuLimitMillicores: number; memoryLimitBytes: number; pidsLimit: number },
  ): Promise<WorkloadUsage | null> {
    const last = this.lastSampled.get(workloadId) ?? 0;

    if (Date.now() - last < this.options.sampleIntervalMs) {
      return this.windows.latest(workloadId);
    }

    this.lastSampled.set(workloadId, Date.now());

    const stats = await this.execution.stats({ externalId });

    if (!stats) return this.windows.latest(workloadId);

    const usage: WorkloadUsage = {
      cpuMillicores: stats.cpuMillicores,
      cpuLimitMillicores: limits.cpuLimitMillicores,
      memoryBytes: stats.memoryBytes,
      memoryLimitBytes: limits.memoryLimitBytes,
      pids: stats.pids,
      pidsLimit: limits.pidsLimit,
      at: stats.at.toISOString(),
    };

    this.windows.record(workloadId, usage);
    return usage;
  }

  private async probe(
    target: { host: string; port: number },
    check: HealthCheckConfig,
  ): Promise<ApplicationHealth> {
    const result = await probeApplication({
      host: target.host,
      port: target.port,
      path: check.path,
      timeoutMs: check.timeoutMs,
    });

    const checkedAt = new Date().toISOString();

    if (result.statusCode === null) {
      return {
        state: 'unreachable',
        statusCode: null,
        latencyMs: result.latencyMs,
        checkedAt,
        message: result.message,
      };
    }

    const healthy = result.statusCode < 400;

    return {
      state: healthy ? 'healthy' : 'unhealthy',
      statusCode: result.statusCode,
      latencyMs: result.latencyMs,
      checkedAt,
      message: healthy ? null : `The application answered with ${String(result.statusCode)}.`,
    };
  }
}

function unknownHealth(message: string): ApplicationHealth {
  return { state: 'unknown', statusCode: null, latencyMs: null, checkedAt: null, message };
}
