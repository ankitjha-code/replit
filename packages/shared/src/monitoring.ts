import { z } from 'zod';

/**
 * What a project's workloads are actually using, and whether they answer.
 *
 * Two questions that look like one and are not. "Is it using a lot of memory"
 * is about a container; "is it up" is about the program inside it, and a
 * container can be comfortably within every limit while the application in it
 * returns 500 to everybody.
 *
 * Everything here is **measured or absent**. A number that could not be read is
 * null and is shown as "not measured", never as zero: a memory reading of zero
 * and a memory reading that failed look identical on a chart and mean opposite
 * things. That rule is why so many of these fields are nullable.
 */

/** What one workload is using right now. */
export const workloadUsageSchema = z.object({
  /**
   * Processor use as a share of one core, in millicores.
   *
   * Expressed against the limit the workload was given rather than against the
   * machine, because the limit is what the workload can actually have and the
   * machine is shared with everything else on it.
   */
  cpuMillicores: z.number().nonnegative().nullable(),
  cpuLimitMillicores: z.number().int().positive(),

  memoryBytes: z.number().int().nonnegative().nullable(),
  memoryLimitBytes: z.number().int().positive(),

  /** Processes and threads. A fork bomb costs neither processor nor memory. */
  pids: z.number().int().nonnegative().nullable(),
  pidsLimit: z.number().int().positive(),

  /** When the reading was taken, which is not when it was asked for. */
  at: z.string(),
});

export type WorkloadUsage = z.infer<typeof workloadUsageSchema>;

/**
 * Where a project's application stands, as seen from outside it.
 *
 * Deliberately coarser than an HTTP status. What somebody wants to know is
 * whether the thing is answering; which 2xx it answered with is detail, and
 * which 5xx is a matter for the log.
 */
export const APPLICATION_HEALTH_STATES = [
  /** Answered, with a status the check accepts. */
  'healthy',
  /** Answered, with a status the check does not accept. */
  'unhealthy',
  /** Nothing answered in time. */
  'unreachable',
  /**
   * Nothing was checked, and that is not a failure.
   *
   * Nothing is running, or this installation cannot reach workloads at all. A
   * platform that reported "unhealthy" for a project nobody has started would
   * be alarming about the absence of a problem.
   */
  'unknown',
] as const;

export type ApplicationHealthState = (typeof APPLICATION_HEALTH_STATES)[number];

export const applicationHealthSchema = z.object({
  state: z.enum(APPLICATION_HEALTH_STATES),
  /** What answered, when something did. */
  statusCode: z.number().int().nullable(),
  latencyMs: z.number().int().nonnegative().nullable(),
  /** When the check ran. Null when nothing has been checked yet. */
  checkedAt: z.string().nullable(),
  /** Why it is in this state, when that needs saying. Safe to show. */
  message: z.string().nullable(),
});

export type ApplicationHealth = z.infer<typeof applicationHealthSchema>;

/**
 * The path a health check asks for.
 *
 * Configurable because "/" is the wrong answer for plenty of applications: an
 * API that serves no page at its root would be reported unhealthy for doing
 * exactly what it was written to do.
 */
export const MAX_HEALTH_PATH_LENGTH = 200;

export const healthCheckPathSchema = z
  .string()
  .trim()
  .min(1, 'Enter a path')
  .max(MAX_HEALTH_PATH_LENGTH)
  .refine((value) => value.startsWith('/'), 'A path starts with a slash')
  .refine((value) => !value.includes('\0'), 'A path cannot contain a null byte')
  // It becomes the path of a request this platform makes. A whole URL there
  // would be a way to aim the platform's own client at somewhere else.
  .refine((value) => !value.startsWith('//'), 'Give a path, not an address');

export const healthCheckConfigSchema = z.object({
  path: healthCheckPathSchema,
  /**
   * Statuses below this are accepted.
   *
   * A single ceiling rather than a list. Anything under 400 is the application
   * saying it handled the request, which is the question being asked, and a
   * list would invite somebody to accept 500 and call it monitoring.
   */
  timeoutMs: z.number().int().min(100).max(30_000),
});

export type HealthCheckConfig = z.infer<typeof healthCheckConfigSchema>;

export const updateHealthCheckRequestSchema = z.object({
  path: healthCheckPathSchema,
  timeoutMs: z.number().int().min(100).max(30_000).optional(),
});

export type UpdateHealthCheckRequest = z.infer<typeof updateHealthCheckRequestSchema>;

/** One thing being watched: a project's workspace runtime, or a deployment. */
export const WATCHED_KINDS = ['RUNTIME', 'DEPLOYMENT'] as const;

export type WatchedKind = (typeof WATCHED_KINDS)[number];

export const watchedWorkloadSchema = z.object({
  kind: z.enum(WATCHED_KINDS),
  /** The runtime or deployment this describes. */
  id: z.string(),
  /** What to call it on screen. A deployment's note, or the runtime's language. */
  label: z.string(),
  /** Null when the workload exists and nothing could be measured. */
  usage: workloadUsageSchema.nullable(),
  /** Recent readings, oldest first, for a trend rather than a single number. */
  history: z.array(workloadUsageSchema),
  health: applicationHealthSchema,
});

export type WatchedWorkload = z.infer<typeof watchedWorkloadSchema>;

export const monitoringResponseSchema = z.object({
  workloads: z.array(watchedWorkloadSchema),
  /** How a project's applications are checked. */
  healthCheck: healthCheckConfigSchema,
  /**
   * Why nothing can be measured here, or null when it can.
   *
   * An installation with no execution backend measures nothing, and says so
   * rather than reporting a project that uses no resources.
   */
  unavailableReason: z.string().nullable(),
  /**
   * How long the trend covers, and how often it is sampled.
   *
   * Said because the history is held in memory and is not a record: it starts
   * when the control plane starts, and it is gone when the process is.
   */
  historySeconds: z.number().int().positive(),
  sampleIntervalSeconds: z.number().int().positive(),
});

export type MonitoringResponse = z.infer<typeof monitoringResponseSchema>;

/** A reading as a share of its limit, for a bar. Null stays null. */
export function usageFraction(used: number | null, limit: number): number | null {
  if (used === null || limit <= 0) return null;
  return Math.min(used / limit, 1);
}
