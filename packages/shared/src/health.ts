import { z } from 'zod';

/**
 * Liveness/readiness contract. `live` means the process is up; `ready` means
 * every dependency it needs to serve traffic answered.
 */
export const dependencyHealthSchema = z.object({
  name: z.string(),
  status: z.enum(['up', 'down', 'unknown']),
  /** Round-trip time of the probe, in milliseconds. Absent if not probed. */
  latencyMs: z.number().nonnegative().optional(),
  detail: z.string().optional(),
});

export const healthResponseSchema = z.object({
  status: z.enum(['ok', 'degraded', 'down']),
  service: z.string(),
  version: z.string(),
  uptimeSeconds: z.number().nonnegative(),
  dependencies: z.array(dependencyHealthSchema),
});

export type DependencyHealth = z.infer<typeof dependencyHealthSchema>;
export type HealthResponse = z.infer<typeof healthResponseSchema>;
