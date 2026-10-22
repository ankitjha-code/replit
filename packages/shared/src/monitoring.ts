import { z } from 'zod';

export const workloadUsageSchema = z.object({
  cpuMillicores: z.number().nonnegative().nullable(),
  cpuLimitMillicores: z.number().int().positive(),

  memoryBytes: z.number().int().nonnegative().nullable(),
  memoryLimitBytes: z.number().int().positive(),

  pids: z.number().int().nonnegative().nullable(),
  pidsLimit: z.number().int().positive(),

  at: z.string(),
});

export type WorkloadUsage = z.infer<typeof workloadUsageSchema>;

export const APPLICATION_HEALTH_STATES = [
  'healthy',
  'unhealthy',
  'unreachable',
  'unknown',
] as const;

export type ApplicationHealthState = (typeof APPLICATION_HEALTH_STATES)[number];

export const applicationHealthSchema = z.object({
  state: z.enum(APPLICATION_HEALTH_STATES),
  statusCode: z.number().int().nullable(),
  latencyMs: z.number().int().nonnegative().nullable(),
  checkedAt: z.string().nullable(),
  message: z.string().nullable(),
});

export type ApplicationHealth = z.infer<typeof applicationHealthSchema>;

export const MAX_HEALTH_PATH_LENGTH = 200;

export const healthCheckPathSchema = z
  .string()
  .trim()
  .min(1, 'Enter a path')
  .max(MAX_HEALTH_PATH_LENGTH)
  .refine((value) => value.startsWith('/'), 'A path starts with a slash')
  .refine((value) => !value.includes('\0'), 'A path cannot contain a null byte')
  .refine((value) => !value.startsWith('//'), 'Give a path, not an address');

export const healthCheckConfigSchema = z.object({
  path: healthCheckPathSchema,
  timeoutMs: z.number().int().min(100).max(30_000),
});

export type HealthCheckConfig = z.infer<typeof healthCheckConfigSchema>;

export const updateHealthCheckRequestSchema = z.object({
  path: healthCheckPathSchema,
  timeoutMs: z.number().int().min(100).max(30_000).optional(),
});

export type UpdateHealthCheckRequest = z.infer<typeof updateHealthCheckRequestSchema>;

export const WATCHED_KINDS = ['RUNTIME', 'DEPLOYMENT'] as const;

export type WatchedKind = (typeof WATCHED_KINDS)[number];

export const watchedWorkloadSchema = z.object({
  kind: z.enum(WATCHED_KINDS),
  id: z.string(),
  label: z.string(),
  usage: workloadUsageSchema.nullable(),
  history: z.array(workloadUsageSchema),
  health: applicationHealthSchema,
});

export type WatchedWorkload = z.infer<typeof watchedWorkloadSchema>;

export const monitoringResponseSchema = z.object({
  workloads: z.array(watchedWorkloadSchema),
  healthCheck: healthCheckConfigSchema,
  unavailableReason: z.string().nullable(),
  historySeconds: z.number().int().positive(),
  sampleIntervalSeconds: z.number().int().positive(),
});

export type MonitoringResponse = z.infer<typeof monitoringResponseSchema>;

export function usageFraction(used: number | null, limit: number): number | null {
  if (used === null || limit <= 0) return null;
  return Math.min(used / limit, 1);
}
