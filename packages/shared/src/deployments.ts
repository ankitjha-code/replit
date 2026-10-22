import { z } from 'zod';
import { DEPLOYMENT_STATUSES } from './lifecycle.js';

/**
 * Deployments: a project, running somewhere that is not somebody's workspace.
 *
 * The distinction from a runtime is the whole point of the phase, and it is not
 * a matter of scale. A runtime exists because somebody has a browser tab open:
 * it is seeded from the project's files as they are this second, it is expected
 * to be restarted constantly, and nothing outside the platform should ever
 * reach it. A deployment is the opposite of each of those:
 *
 *  - It is built from a **fixed version** of the project, recorded when it was
 *    created. Editing a file afterwards does not change what is deployed, and
 *    that is the property people actually want from the word "deployed".
 *  - It is expected to **outlive every session**, including the one that made
 *    it and including the control plane restarting.
 *  - It is meant to be **reachable by people who have no account here**, which
 *    is a different security problem from a preview and gets its own listener.
 *
 * This file describes what a deployment is and what may be asked of it. Nothing
 * in this task builds an image or serves any traffic: the provider port has one
 * implementation and it refuses, honestly, exactly as the execution and storage
 * ports did before theirs existed.
 */

/**
 * What kind of thing is being deployed.
 *
 * Two, because they need different infrastructure rather than different
 * settings. A static site is files behind a web server and can be served
 * without running any of the project's own code; a server deployment is the
 * project's own process, with everything that implies about resources, restarts
 * and isolation. Pretending they are one thing with a flag would mean the
 * simplest case carrying the cost of the hardest.
 */
export const DEPLOYMENT_TARGETS = ['STATIC', 'SERVER'] as const;

export type DeploymentTarget = (typeof DEPLOYMENT_TARGETS)[number];

export const DEPLOYMENT_TARGET_LABELS: Readonly<Record<DeploymentTarget, string>> = {
  STATIC: 'Static site',
  SERVER: 'Server',
};

/** The longest build or start command a deployment will carry. */
export const MAX_DEPLOYMENT_COMMAND_LENGTH = 2_000;

/**
 * Where a static build puts its output, relative to the project root.
 *
 * Bounded and validated because it becomes a path inside a build container, and
 * because "dist" and "../../etc" are the same shape of string.
 */
export const MAX_DEPLOYMENT_DIRECTORY_LENGTH = 200;

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code === 0x09 || code === 0x0a) continue;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

export const deploymentCommandSchema = z
  .string()
  .trim()
  .min(1, 'Enter a command')
  .max(MAX_DEPLOYMENT_COMMAND_LENGTH)
  .refine((value) => !hasControlCharacters(value), 'A command cannot contain control characters');

export const deploymentDirectorySchema = z
  .string()
  .trim()
  .min(1, 'Enter a directory')
  .max(MAX_DEPLOYMENT_DIRECTORY_LENGTH)
  .refine((value) => !value.startsWith('/'), 'Give a path inside the project, not an absolute one')
  .refine((value) => !value.split(/[\\/]/).includes('..'), 'A path cannot climb out of the project')
  .refine((value) => !value.includes('\0'), 'A path cannot contain a null byte');

/**
 * What a project is deployed with, kept on the project rather than on each
 * deployment.
 *
 * Configuration outlives any one deployment, exactly as the run command does:
 * saying how to build a project should not have to be repeated every time it is
 * built. What each deployment records is the configuration it actually used,
 * which is a copy and not a reference, so reading an old deployment tells the
 * truth about how it was made.
 */
export const deploymentConfigSchema = z.object({
  target: z.enum(DEPLOYMENT_TARGETS),
  /** Null when the project needs no build step, which is common for a server. */
  buildCommand: deploymentCommandSchema.nullable(),
  /** Where a static build leaves its output. Null for a server deployment. */
  outputDirectory: deploymentDirectorySchema.nullable(),
  /** How the deployed process starts. Null for a static site, which has none. */
  startCommand: deploymentCommandSchema.nullable(),
});

export type DeploymentConfig = z.infer<typeof deploymentConfigSchema>;

/**
 * Refuses a configuration that cannot mean anything.
 *
 * Kept here rather than in the service so the form can say the same thing
 * before the request is sent, and so that the two can never drift into
 * disagreeing about what is valid.
 */
export function deploymentConfigProblem(config: DeploymentConfig): string | undefined {
  if (config.target === 'STATIC') {
    if (!config.outputDirectory) {
      return 'A static site needs to know which directory holds the built files.';
    }
    if (config.startCommand) {
      return 'A static site is served as files, so it has no start command.';
    }
    return undefined;
  }

  if (!config.startCommand) {
    return 'A server deployment needs a command that starts it.';
  }
  if (config.outputDirectory) {
    return 'A server deployment serves its own requests, so it has no output directory.';
  }
  return undefined;
}

export const updateDeploymentConfigRequestSchema = deploymentConfigSchema;

export type UpdateDeploymentConfigRequest = z.infer<typeof updateDeploymentConfigRequestSchema>;

/**
 * Asking for a deployment.
 *
 * Carries nothing but a note, because everything else about how a project is
 * deployed is the project's stored configuration. A request that could override
 * the build command would mean two answers to "how is this project built", and
 * the recorded history would stop being a history of anything.
 */
export const createDeploymentRequestSchema = z.object({
  /** Why this one was made. Optional, and shown in the list. */
  note: z.string().trim().max(200).optional(),
});

export type CreateDeploymentRequest = z.infer<typeof createDeploymentRequestSchema>;

export const deploymentSummarySchema = z.object({
  id: z.string(),
  status: z.enum(DEPLOYMENT_STATUSES),
  target: z.enum(DEPLOYMENT_TARGETS),
  note: z.string().nullable(),

  /**
   * The configuration this deployment was made with.
   *
   * Copied rather than referenced. A deployment that showed the project's
   * current settings would misdescribe itself the moment somebody changed them,
   * which is the opposite of what a record of a release is for.
   */
  buildCommand: z.string().nullable(),
  outputDirectory: z.string().nullable(),
  startCommand: z.string().nullable(),

  /**
   * The snapshot of the project's files this deployment was built from.
   *
   * What makes a deployment a fixed version of a project rather than a moment
   * in an editing session. Null only for a deployment whose snapshot has since
   * been removed, which is recorded rather than hidden.
   */
  snapshotId: z.string().nullable(),

  /** Where it is reachable, once anything serves it. Null until then. */
  url: z.string().nullable(),

  /** Why it is in this state, when that needs saying. Safe to show. */
  message: z.string().nullable(),

  /** Files published, for a static deployment. Null when nothing was stored. */
  fileCount: z.number().int().nonnegative().nullable(),
  /** The stored size of what is served. Null for a server deployment. */
  artifactBytes: z.number().int().nonnegative().nullable(),
  /** True when there is a build log to read. */
  hasLog: z.boolean(),

  requestedBy: z.string().nullable(),
  createdAt: z.string(),
  statusChangedAt: z.string(),
  startedAt: z.string().nullable(),
  stoppedAt: z.string().nullable(),
  /**
   * This release's own address, while it is running.
   *
   * The project's address always points at whatever is live; this points at one
   * release. Null for a release made before releases had addresses, and for one
   * that is not running — the label is kept, but nothing is there to answer.
   */
  releaseUrl: z.string().nullable(),
  /** The release this one was made from, when it was made by rolling back. */
  rolledBackFromId: z.string().nullable(),
});

export type DeploymentSummary = z.infer<typeof deploymentSummarySchema>;

export const deploymentStateResponseSchema = z.object({
  /** Newest first. */
  deployments: z.array(deploymentSummarySchema),
  /**
   * The label this project is published under, and the address it makes.
   *
   * Null until the project is first deployed. Assigned then rather than at
   * creation, because a name nobody is using is a name taken from everybody
   * else for nothing.
   */
  subdomain: z.string().nullable(),
  url: z.string().nullable(),
  /** How the project is currently set up to deploy, or null if nobody has said. */
  config: deploymentConfigSchema.nullable(),
  /** What the platform would suggest, from the project's files. Null when it cannot tell. */
  suggestion: deploymentConfigSchema.nullable(),
  /**
   * The one that is serving traffic, if any.
   *
   * Separate from the list rather than derived by the client, because "which is
   * live" is a question about the platform's state and not about the order of
   * an array.
   */
  liveId: z.string().nullable(),
  /**
   * Why deployments cannot be made here, or null when they can.
   *
   * An installation with no deployment backend says so rather than accepting
   * requests it will never act on. The same shape the runtime and storage
   * surfaces use, for the same reason.
   */
  unavailableReason: z.string().nullable(),
  /** How many one project may keep before the oldest are pruned. */
  limit: z.number().int().positive(),
});

export type DeploymentStateResponse = z.infer<typeof deploymentStateResponseSchema>;

export const deploymentResponseSchema = z.object({ deployment: deploymentSummarySchema });

export type DeploymentResponse = z.infer<typeof deploymentResponseSchema>;

/**
 * What a build printed.
 *
 * Fetched on request rather than carried in the listing: a log is large, most
 * of the time nobody looks at it, and putting it in the list would make every
 * page load pay for every build that ever ran.
 */
export const deploymentLogResponseSchema = z.object({
  log: z.string(),
  /** True when the start was dropped to stay inside what the platform keeps. */
  truncated: z.boolean(),
});

export type DeploymentLogResponse = z.infer<typeof deploymentLogResponseSchema>;

/**
 * Making an earlier release live again.
 *
 * A new release pointing at old code, never a resurrection of an old row:
 * history stays a list of what happened, and going back is one of the things
 * that happened.
 *
 * What it costs depends on what was deployed, and the difference is not hidden:
 *
 * - **A static site rolls back without building.** Its output is in object
 *   storage, so going back is copying an archive.
 * - **A server rebuilds from the same frozen source.** There is no image
 *   registry here — a server is built and run in one container, deliberately —
 *   so the only thing kept is the exact code, and going back means building it
 *   again. The result is the same release; the wait is not.
 */
export const rollbackRequestSchema = z.object({
  /** Optional note, as with any release. What it is going back to is recorded. */
  note: z.string().trim().max(200).optional(),
});

export type RollbackRequest = z.infer<typeof rollbackRequestSchema>;
