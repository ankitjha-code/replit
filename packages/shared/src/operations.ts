import { z } from 'zod';

/**
 * The installation, seen whole.
 *
 * Everything the platform offers until now is scoped to a project or to an
 * account, which is right for the people using it and leaves nobody able to
 * answer "is this installation healthy" without reading logs on the machine.
 *
 * ## What an operator is not
 *
 * An operator sees the installation. They do **not** get access to any project:
 * not its files, not its secrets, not its logs, not its terminal. The shapes
 * below are the whole of what is visible, and none of them carries project
 * content — a project appears as a name, an owner and some numbers.
 *
 * That boundary is what keeps this from being a backdoor into everybody's work,
 * and it is enforced by operators having no membership in anything rather than
 * by each endpoint remembering to check.
 */

export const operationsOverviewSchema = z.object({
  accounts: z.object({
    total: z.number().int().min(0),
    verified: z.number().int().min(0),
    operators: z.number().int().min(0),
  }),
  projects: z.object({
    total: z.number().int().min(0),
    /** Projects with a runtime that is up right now. */
    running: z.number().int().min(0),
  }),
  deployments: z.object({
    live: z.number().int().min(0),
    failed: z.number().int().min(0),
  }),
  jobs: z.object({
    queued: z.number().int().min(0),
    running: z.number().int().min(0),
    /** Work that has been given up on, which is the number worth watching. */
    failed: z.number().int().min(0),
  }),
});

export type OperationsOverview = z.infer<typeof operationsOverviewSchema>;

/**
 * One execution host, as the scheduler sees it.
 *
 * Declared capacity rather than measured: the platform schedules against what an
 * operator said a machine may give it, and showing the machine's own totals
 * would invite the mistake of filling a host that is also doing something else.
 */
export const operationsHostSchema = z.object({
  name: z.string(),
  schedulable: z.boolean(),
  /** An operator has taken it out of placement. Defaulted for older answers. */
  draining: z.boolean().default(false),
  /** Why the platform cannot use it, or null. */
  reason: z.string().nullable(),
  cpuMillicores: z.object({ used: z.number().int(), declared: z.number().int() }),
  memoryMb: z.object({ used: z.number().int(), declared: z.number().int() }),
  workloads: z.object({ used: z.number().int(), declared: z.number().int() }),
});

export type OperationsHost = z.infer<typeof operationsHostSchema>;

export const operationsHostsResponseSchema = z.object({
  hosts: z.array(operationsHostSchema),
});

/** One account, with nothing on it that is not already the account's own. */
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
  /** Present when there are more; the caller pages by passing it back. */
  nextCursor: z.string().nullable(),
});

export const setOperatorRequestSchema = z.object({
  isOperator: z.boolean(),
});

export type SetOperatorRequest = z.infer<typeof setOperatorRequestSchema>;

export const setHostDrainRequestSchema = z.object({ draining: z.boolean() });
export type SetHostDrainRequest = z.infer<typeof setHostDrainRequestSchema>;

/**
 * What one cleanup pass found and did.
 *
 * Exposed to operators because a routine that deletes containers on a timer is
 * one somebody has to be able to watch. `dryRun` is the same report with nothing
 * removed, which is how an operator checks what it would do before letting it.
 */
export const sweepStepSchema = z.object({
  found: z.number().int().min(0),
  orphaned: z.number().int().min(0),
  removed: z.number().int().min(0),
  failed: z.number().int().min(0),
  /** Why this step did nothing, when it did nothing. */
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
  /** Report what would be removed and remove nothing. Defaults to the safe one. */
  dryRun: z.boolean().default(true),
});

export type RunSweepRequest = z.infer<typeof runSweepRequestSchema>;
