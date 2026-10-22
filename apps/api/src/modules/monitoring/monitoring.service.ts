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

/**
 * What a project's workloads are using, and whether they answer.
 *
 * Two questions that look like one. A container can sit comfortably inside
 * every limit while the application in it returns 500 to everybody, and a
 * container at its memory ceiling can be serving perfectly well. So this
 * reports both and never derives one from the other.
 *
 * The rule that shapes every line of it: **measured or absent**. A number that
 * could not be read is null and is shown as "not measured", never as zero. A
 * memory reading of zero and a memory reading that failed look identical on a
 * chart and mean opposite things, and a monitoring page that quietly turns the
 * second into the first is worse than no page.
 *
 * ## Why there is no sampler
 *
 * Readings are taken when somebody asks for them, throttled so that two people
 * watching one project do not double the cost, and kept in a small in-memory
 * window. Not a background timer writing to a table, for two reasons:
 *
 *  - A sample per workload per interval would be this platform's highest-volume
 *    write by a wide margin, for data whose value collapses within minutes.
 *    Nobody asks what a container's processor use was last Tuesday.
 *  - A timer would measure every project all the time, including the ones
 *    nobody is looking at, which is the opposite of where the cost should fall.
 *
 * The consequence is stated rather than hidden: the trend starts when the page
 * is opened and is gone when the control plane restarts.
 */

export interface MonitoringServiceOptions {
  /** How often a reading is taken, however often it is asked for. */
  sampleIntervalMs: number;
  /** How many readings the trend holds. */
  historySamples: number;
  /** The default path a health check asks for, when a project has not said. */
  defaultHealthPath: string;
  defaultHealthTimeoutMs: number;
}

/**
 * Where a project's workspace application can be reached, if it is running.
 *
 * The preview service already answers exactly this, having probed for the port
 * and remembered it. Asking it rather than probing again means the health check
 * and the preview can never disagree about which port the application is on.
 */
interface PreviewTargets {
  target(projectId: string): Promise<{ host: string; port: number } | undefined>;
}

/** Where a project's deployment can be reached, if one is serving. */
interface ServingDeployments {
  serving(projectId: string): Promise<ServingDeployment | null>;
}

/** The project's own health-check settings. */
interface HealthCheckStore {
  read(projectId: string): Promise<{ path: string | null; timeoutMs: number | null } | null>;
  write(projectId: string, input: { path: string; timeoutMs: number }): Promise<void>;
}

export class MonitoringService {
  private readonly windows: UsageWindows;

  /** When each workload was last measured, so a reading is not taken per viewer. */
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

  /** Everything a project's monitoring page needs, in one answer. */
  async describe(projectId: string): Promise<MonitoringResponse> {
    const unavailableReason = await this.execution.unavailableReason();
    const healthCheck = await this.healthCheck(projectId);

    const workloads = unavailableReason
      ? []
      : [
          ...(await this.describeRuntime(projectId, healthCheck)),
          ...(await this.describeDeployments(projectId, healthCheck)),
        ];

    // Anything no longer watched is forgotten, so a project started and stopped
    // a hundred times does not leave a hundred windows behind.
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

  /**
   * What is deployed and serving, measured now, or null when nothing is.
   *
   * For alerting, which needs the same reading the page shows — the same health
   * check, the same ceiling — so an alert and the page can never disagree about
   * whether something is wrong.
   */
  async deploymentReading(projectId: string): Promise<WatchedWorkload | null> {
    if (await this.execution.unavailableReason()) return null;
    const [workload] = await this.describeDeployments(projectId, await this.healthCheck(projectId));
    return workload ?? null;
  }

  /** How this project's application is checked. */
  async healthCheck(projectId: string): Promise<HealthCheckConfig> {
    const stored = await this.settings.read(projectId);

    return {
      path: stored?.path ?? this.options.defaultHealthPath,
      timeoutMs: stored?.timeoutMs ?? this.options.defaultHealthTimeoutMs,
    };
  }

  /** Changes what is asked for, and how long to wait for it. */
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

  // -------------------------------------------------------------------------

  /** The project's workspace runtime, when it has one running. */
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

  /** Whatever the project currently has deployed. */
  private async describeDeployments(
    projectId: string,
    check: HealthCheckConfig,
  ): Promise<WatchedWorkload[]> {
    const record = await this.deployments.findServing(projectId);
    if (!record) return [];

    const label = record.note ?? (record.target === 'STATIC' ? 'Static site' : 'Server');

    /*
     * A static deployment has nothing running and nothing to probe.
     *
     * Its health is the platform's own: the platform holds the bytes and
     * answers for them. Reporting that as "healthy" is a measured fact — the
     * lookup that serves it just succeeded — rather than an assumption, and
     * reporting it as "unknown" would be alarming about a site that works.
     */
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

  /**
   * What a deployment is allowed of the machine.
   *
   * Read from the same configuration the deployment provider used, because a
   * bar against the wrong ceiling is worse than no bar: it would say a workload
   * is comfortable when it is at its limit, or the reverse.
   */
  private deploymentLimits = { cpuMillicores: 1_000, memoryMb: 512, pidsLimit: 256 };

  useDeploymentLimits(limits: {
    cpuMillicores: number;
    memoryMb: number;
    pidsLimit: number;
  }): void {
    this.deploymentLimits = limits;
  }

  /**
   * Takes a reading, or reuses the last one.
   *
   * Throttled by the sample interval rather than by the caller, so two people
   * watching one project cost the same as one. Returns whatever is in the
   * window when it is too soon, which is a real reading taken a moment ago
   * rather than a fabricated one.
   */
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

    // Nothing measured. Null rather than a row of zeroes, and nothing is added
    // to the window: a gap in a trend is the truth about a gap in the readings.
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

  /** Asks the application whether it is answering. */
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

    /*
     * Anything under 400 is the application saying it handled the request.
     *
     * A ceiling rather than a list of accepted statuses. A list would invite
     * somebody to accept 500 and call the result monitoring, and the question
     * being asked here is only whether the application is answering for itself.
     */
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
