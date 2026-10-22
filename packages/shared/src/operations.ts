import { z } from 'zod';

export const operationsOverviewSchema = z.object({
  accounts: z.object({
    total: z.number().int().min(0),
    verified: z.number().int().min(0),
    operators: z.number().int().min(0),
  }),
  projects: z.object({
    total: z.number().int().min(0),
    running: z.number().int().min(0),
  }),
  deployments: z.object({
    live: z.number().int().min(0),
    failed: z.number().int().min(0),
  }),
  jobs: z.object({
    queued: z.number().int().min(0),
    running: z.number().int().min(0),
    failed: z.number().int().min(0),
  }),
});

export type OperationsOverview = z.infer<typeof operationsOverviewSchema>;

export const operationsHostSchema = z.object({
  name: z.string(),
  schedulable: z.boolean(),
  draining: z.boolean().default(false),
  reason: z.string().nullable(),
  cpuMillicores: z.object({ used: z.number().int(), declared: z.number().int() }),
  memoryMb: z.object({ used: z.number().int(), declared: z.number().int() }),
  workloads: z.object({ used: z.number().int(), declared: z.number().int() }),
});

export type OperationsHost = z.infer<typeof operationsHostSchema>;

export const operationsHostsResponseSchema = z.object({
  hosts: z.array(operationsHostSchema),
});

export const operationsAccountSchema = z.object({
  id: z.string(),
  username: z.string(),
  email: z.string(),
  emailVerified: z.boolean(),
  isOperator: z.boolean(),
  projects: z.number().int().min(0),
  createdAt: z.string(),
});

export type OperationsAccount = z.infer<typeof operationsAccountSchema>;

export const operationsAccountsResponseSchema = z.object({
  accounts: z.array(operationsAccountSchema),
  nextCursor: z.string().nullable(),
});

export const setOperatorRequestSchema = z.object({
  isOperator: z.boolean(),
});

export type SetOperatorRequest = z.infer<typeof setOperatorRequestSchema>;

export const setHostDrainRequestSchema = z.object({ draining: z.boolean() });
export type SetHostDrainRequest = z.infer<typeof setHostDrainRequestSchema>;

export const sweepStepSchema = z.object({
  found: z.number().int().min(0),
  orphaned: z.number().int().min(0),
  removed: z.number().int().min(0),
  failed: z.number().int().min(0),
  skipped: z.string().nullable(),
});

export const sweepReportSchema = z.object({
  startedAt: z.string(),
  finishedAt: z.string(),
  dryRun: z.boolean(),
  containers: sweepStepSchema,
  networks: sweepStepSchema,
  databases: sweepStepSchema,
  objects: sweepStepSchema,
  sessions: z.object({ removed: z.number().int().min(0) }),
  tokens: z.object({ removed: z.number().int().min(0) }),
});

export type SweepReportView = z.infer<typeof sweepReportSchema>;

export const runSweepRequestSchema = z.object({
  dryRun: z.boolean().default(true),
});

export type RunSweepRequest = z.infer<typeof runSweepRequestSchema>;
