import { z } from 'zod';

/**
 * Git integration: a real git repository holding a project's history.
 *
 * Real in the sense that matters: the objects are git objects, the commits have
 * git's own hashes and parents, and the repository can be opened by git itself.
 * A history the platform invented, in a format only the platform can read,
 * would be a worse version of snapshots rather than a different feature.
 *
 * What it is not, yet: connected to anywhere. There is no remote, no push and
 * no pull. Those need credentials for somewhere else and a policy about what
 * the platform may reach over the network, which is its own piece of work.
 */

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

/** How a file differs between a commit and the one before it. */
export const GIT_CHANGE_KINDS = ['added', 'modified', 'removed'] as const;

export type GitChangeKind = (typeof GIT_CHANGE_KINDS)[number];

export const gitChangeSchema = z.object({
  path: z.string(),
  kind: z.enum(GIT_CHANGE_KINDS),
});

export type GitChange = z.infer<typeof gitChangeSchema>;

export const gitCommitSchema = z.object({
  /** The real object id. Forty hexadecimal characters, as git computed it. */
  oid: z.string(),
  message: z.string(),
  /**
   * Who wrote it, as recorded in the commit.
   *
   * Taken from the signed-in account when the commit was made, never from the
   * request: an author line a caller could choose is a signature that means
   * nothing.
   */
  authorName: z.string(),
  authorEmail: z.string(),
  /** Seconds since the epoch, which is what git itself stores. */
  timestamp: z.number().int(),
  parents: z.array(z.string()),
});

export type GitCommit = z.infer<typeof gitCommitSchema>;

/**
 * A branch name git and this platform will both accept.
 *
 * Narrower than git's own rules on purpose: no spaces, no `..`, no leading dash
 * or dot, nothing ending in `.lock` or `/`. Every name that passes is one git
 * accepts and one that means the same thing on every machine it is pushed to.
 */
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
  /** The commit it points at. */
  headOid: z.string(),
  /** Whether the project's files are this branch. */
  current: z.boolean(),
});

export type GitBranch = z.infer<typeof gitBranchSchema>;

export const createBranchRequestSchema = z.object({
  name: branchNameSchema,
  /** The commit to start from. The current branch's newest commit when absent. */
  from: z
    .string()
    .regex(/^[0-9a-f]{40}$/)
    .optional(),
});

export type CreateBranchRequest = z.infer<typeof createBranchRequestSchema>;

export const mergeBranchRequestSchema = z.object({ branch: branchNameSchema });
export type MergeBranchRequest = z.infer<typeof mergeBranchRequestSchema>;

/**
 * What a merge did.
 *
 * `fastForward` when the current branch simply moved forward, `merged` when a
 * merge commit was made, `upToDate` when there was nothing to bring in.
 */
export const mergeResultSchema = z.object({
  outcome: z.enum(['fastForward', 'merged', 'upToDate']),
  headOid: z.string(),
});

export type MergeResult = z.infer<typeof mergeResultSchema>;

/**
 * Where a project's history is pushed to and pulled from.
 *
 * One per project. The token is write-only: it is sent when set and never
 * returned, and `hasToken` is all anybody is told about it.
 */
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
  /** An https address. Plain http only where an operator has allowed it. */
  url: z.url().max(500),
  username: z.string().trim().max(200).optional(),
  /**
   * A personal access token or password. Absent keeps the stored one, an empty
   * string removes it: so changing the address does not mean retyping a secret.
   */
  token: z.string().max(1000).optional(),
});

export type SetGitRemoteRequest = z.infer<typeof setGitRemoteRequestSchema>;

export const pushRequestSchema = z.object({
  /** Replace the remote branch even if it has commits this one does not. Off by default. */
  force: z.boolean().default(false),
});

export type PushRequest = z.infer<typeof pushRequestSchema>;

export const gitStateResponseSchema = z.object({
  /**
   * Whether a repository exists for this project.
   *
   * False before the first commit. A repository with no commits is not
   * something anybody needs to see, so one is made when it is first needed
   * rather than when a project is created.
   */
  initialized: z.boolean(),
  /** Newest first. Empty before the first commit. */
  commits: z.array(gitCommitSchema),
  /**
   * Whether the project's files differ from the newest commit.
   *
   * The answer to "is there anything to commit", worked out by comparing the
   * files to the tree rather than by trusting a flag somebody set.
   */
  hasUncommittedChanges: z.boolean(),
  /** What would go into the next commit. Empty when there is nothing to commit. */
  pendingChanges: z.array(gitChangeSchema),
  /**
   * Why git cannot be used here, or null when it can.
   *
   * The repository is kept in object storage, so an installation without one
   * says so rather than offering a history it has nowhere to write.
   */
  unavailableReason: z.string().nullable(),
  /**
   * The branch the project's files are, and every branch there is.
   *
   * Defaulted so an answer from before branching existed still reads.
   */
  branch: z.string().default('main'),
  branches: z.array(gitBranchSchema).default([]),
});

export type GitStateResponse = z.infer<typeof gitStateResponseSchema>;

export const gitCommitDetailResponseSchema = z.object({
  commit: gitCommitSchema,
  /** What this commit changed, against its first parent. */
  changes: z.array(gitChangeSchema),
});

export type GitCommitDetailResponse = z.infer<typeof gitCommitDetailResponseSchema>;
