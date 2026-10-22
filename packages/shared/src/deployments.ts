import { z } from 'zod';
import { DEPLOYMENT_STATUSES } from './lifecycle.js';

export const DEPLOYMENT_TARGETS = ['STATIC', 'SERVER'] as const;

export type DeploymentTarget = (typeof DEPLOYMENT_TARGETS)[number];

export const DEPLOYMENT_TARGET_LABELS: Readonly<Record<DeploymentTarget, string>> = {
  STATIC: 'Static site',
  SERVER: 'Server',
};

export const MAX_DEPLOYMENT_COMMAND_LENGTH = 2_000;

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

export const deploymentConfigSchema = z.object({
  target: z.enum(DEPLOYMENT_TARGETS),
  buildCommand: deploymentCommandSchema.nullable(),
  outputDirectory: deploymentDirectorySchema.nullable(),
  startCommand: deploymentCommandSchema.nullable(),
});

export type DeploymentConfig = z.infer<typeof deploymentConfigSchema>;

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

export const createDeploymentRequestSchema = z.object({
  note: z.string().trim().max(200).optional(),
});

export type CreateDeploymentRequest = z.infer<typeof createDeploymentRequestSchema>;

export const deploymentSummarySchema = z.object({
  id: z.string(),
  status: z.enum(DEPLOYMENT_STATUSES),
  target: z.enum(DEPLOYMENT_TARGETS),
  note: z.string().nullable(),

  buildCommand: z.string().nullable(),
  outputDirectory: z.string().nullable(),
  startCommand: z.string().nullable(),

  snapshotId: z.string().nullable(),

  url: z.string().nullable(),

  message: z.string().nullable(),

  fileCount: z.number().int().nonnegative().nullable(),
  artifactBytes: z.number().int().nonnegative().nullable(),
  hasLog: z.boolean(),

  requestedBy: z.string().nullable(),
  createdAt: z.string(),
  statusChangedAt: z.string(),
  startedAt: z.string().nullable(),
  stoppedAt: z.string().nullable(),
  releaseUrl: z.string().nullable(),
  rolledBackFromId: z.string().nullable(),
});

export type DeploymentSummary = z.infer<typeof deploymentSummarySchema>;

export const deploymentStateResponseSchema = z.object({
  deployments: z.array(deploymentSummarySchema),
  subdomain: z.string().nullable(),
  url: z.string().nullable(),
  config: deploymentConfigSchema.nullable(),
  suggestion: deploymentConfigSchema.nullable(),
  liveId: z.string().nullable(),
  unavailableReason: z.string().nullable(),
  limit: z.number().int().positive(),
});

export type DeploymentStateResponse = z.infer<typeof deploymentStateResponseSchema>;

export const deploymentResponseSchema = z.object({ deployment: deploymentSummarySchema });

export type DeploymentResponse = z.infer<typeof deploymentResponseSchema>;

export const deploymentLogResponseSchema = z.object({
  log: z.string(),
  truncated: z.boolean(),
});

export type DeploymentLogResponse = z.infer<typeof deploymentLogResponseSchema>;

export const rollbackRequestSchema = z.object({
  note: z.string().trim().max(200).optional(),
});

export type RollbackRequest = z.infer<typeof rollbackRequestSchema>;
