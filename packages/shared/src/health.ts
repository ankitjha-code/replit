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

/**
 * What readiness tells anybody who is not an operator.
 *
 * Each dependency's name and verdict, and nothing else: no version, no uptime,
 * no latency and no probe detail, which carries internal addresses and the
 * driver's own error text. Enough for an uptime monitor, and for a public page
 * to know whether mail can be sent, without mapping the installation for a
 * stranger. A full report also satisfies this shape.
 */
export const publicHealthResponseSchema = z.object({
  status: healthResponseSchema.shape.status,
  dependencies: z.array(dependencyHealthSchema.pick({ name: true, status: true })),
});

export type DependencyHealth = z.infer<typeof dependencyHealthSchema>;
export type HealthResponse = z.infer<typeof healthResponseSchema>;
export type PublicHealthResponse = z.infer<typeof publicHealthResponseSchema>;
