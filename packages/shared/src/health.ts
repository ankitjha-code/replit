import { z } from 'zod';

export const dependencyHealthSchema = z.object({
  name: z.string(),
  status: z.enum(['up', 'down', 'unknown']),
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

export const publicHealthResponseSchema = z.object({
  status: healthResponseSchema.shape.status,
  dependencies: z.array(dependencyHealthSchema.pick({ name: true, status: true })),
});

export type DependencyHealth = z.infer<typeof dependencyHealthSchema>;
export type HealthResponse = z.infer<typeof healthResponseSchema>;
export type PublicHealthResponse = z.infer<typeof publicHealthResponseSchema>;
