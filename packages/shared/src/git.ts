import { z } from 'zod';

export const MAX_COMMIT_MESSAGE_LENGTH = 2000;

export const commitMessageSchema = z
  .string()
  .trim()
  .min(1, 'Say what changed')
  .max(MAX_COMMIT_MESSAGE_LENGTH)
  .refine((text) => !text.includes('\0'), 'A message cannot contain a null byte');

export const commitRequestSchema = z.object({
  message: commitMessageSchema,
});

export type CommitRequest = z.infer<typeof commitRequestSchema>;

export const GIT_CHANGE_KINDS = ['added', 'modified', 'removed'] as const;

export type GitChangeKind = (typeof GIT_CHANGE_KINDS)[number];

export const gitChangeSchema = z.object({
  path: z.string(),
  kind: z.enum(GIT_CHANGE_KINDS),
});

export type GitChange = z.infer<typeof gitChangeSchema>;

export const gitCommitSchema = z.object({
  oid: z.string(),
  message: z.string(),
  authorName: z.string(),
  authorEmail: z.string(),
  timestamp: z.number().int(),
  parents: z.array(z.string()),
});

export type GitCommit = z.infer<typeof gitCommitSchema>;

export const branchNameSchema = z
  .string()
  .trim()
  .min(1, 'Name the branch')
  .max(100, 'A branch name can be at most 100 characters')
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._/-]*$/,
    'Use letters, digits, dots, dashes, underscores and slashes, starting with a letter or digit',
  )
  .refine(
    (name) =>
      !name.includes('..') &&
      !name.includes('//') &&
      !name.endsWith('/') &&
      !name.endsWith('.') &&
      !name.endsWith('.lock') &&
      !name.split('/').some((part) => part.startsWith('.')),
    'That is not a name git allows',
  );

export const gitBranchSchema = z.object({
  name: z.string(),
  headOid: z.string(),
  current: z.boolean(),
});

export type GitBranch = z.infer<typeof gitBranchSchema>;

export const createBranchRequestSchema = z.object({
  name: branchNameSchema,
  from: z
    .string()
    .regex(/^[0-9a-f]{40}$/)
    .optional(),
});

export type CreateBranchRequest = z.infer<typeof createBranchRequestSchema>;

export const mergeBranchRequestSchema = z.object({ branch: branchNameSchema });
export type MergeBranchRequest = z.infer<typeof mergeBranchRequestSchema>;

export const mergeResultSchema = z.object({
  outcome: z.enum(['fastForward', 'merged', 'upToDate']),
  headOid: z.string(),
});

export type MergeResult = z.infer<typeof mergeResultSchema>;

export const gitRemoteSchema = z.object({
  url: z.string(),
  username: z.string().nullable(),
  hasToken: z.boolean(),
  lastPushedAt: z.string().nullable(),
  lastPulledAt: z.string().nullable(),
});

export type GitRemote = z.infer<typeof gitRemoteSchema>;

export const gitRemoteResponseSchema = z.object({ remote: gitRemoteSchema.nullable() });

export const setGitRemoteRequestSchema = z.object({
  url: z.url().max(500),
  username: z.string().trim().max(200).optional(),
  token: z.string().max(1000).optional(),
});

export type SetGitRemoteRequest = z.infer<typeof setGitRemoteRequestSchema>;

export const pushRequestSchema = z.object({
  force: z.boolean().default(false),
});

export type PushRequest = z.infer<typeof pushRequestSchema>;

export const gitStateResponseSchema = z.object({
  initialized: z.boolean(),
  commits: z.array(gitCommitSchema),
  hasUncommittedChanges: z.boolean(),
  pendingChanges: z.array(gitChangeSchema),
  unavailableReason: z.string().nullable(),
  branch: z.string().default('main'),
  branches: z.array(gitBranchSchema).default([]),
});

export type GitStateResponse = z.infer<typeof gitStateResponseSchema>;

export const gitCommitDetailResponseSchema = z.object({
  commit: gitCommitSchema,
  changes: z.array(gitChangeSchema),
});

export type GitCommitDetailResponse = z.infer<typeof gitCommitDetailResponseSchema>;
