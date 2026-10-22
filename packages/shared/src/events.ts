import { z } from 'zod';
import { RUNTIME_STATUSES } from './lifecycle.js';
import { presenceMemberSchema, presenceUpdateSchema } from './presence.js';
import { RUN_STATUSES } from './run.js';

export function projectEventsPath(projectId: string): string {
  return `/ws/projects/${encodeURIComponent(projectId)}/events`;
}

export function projectIdFromEventsPath(pathname: string): string | undefined {
  const match = /^\/ws\/projects\/([^/]+)\/events$/.exec(pathname);
  if (!match?.[1]) return undefined;
  return decodeURIComponent(match[1]);
}

export const BULK_FILE_REASONS = ['runtime-sync', 'restore'] as const;

export type BulkFileReason = (typeof BULK_FILE_REASONS)[number];

export const CONFIG_SCOPES = ['variables', 'secrets', 'database'] as const;

export type ConfigScope = (typeof CONFIG_SCOPES)[number];

export const projectEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('file.written'), path: z.string() }),
  z.object({ type: z.literal('file.removed'), path: z.string() }),
  z.object({ type: z.literal('file.moved'), from: z.string(), to: z.string() }),
  z.object({
    type: z.literal('files.replaced'),
    reason: z.enum(BULK_FILE_REASONS),
    created: z.number().int().nonnegative(),
    updated: z.number().int().nonnegative(),
    deleted: z.number().int().nonnegative(),
  }),
  z.object({ type: z.literal('runtime.changed'), status: z.enum(RUNTIME_STATUSES) }),
  z.object({
    type: z.literal('run.changed'),
    status: z.enum(RUN_STATUSES),
    exitCode: z.number().int().nullable(),
  }),
  z.object({ type: z.literal('snapshots.changed') }),
  z.object({ type: z.literal('history.changed'), headOid: z.string().nullable() }),
  z.object({ type: z.literal('config.changed'), scope: z.enum(CONFIG_SCOPES) }),
  z.object({ type: z.literal('logs.appended') }),
  z.object({ type: z.literal('members.changed'), userId: z.string() }),
  z.object({ type: z.literal('deployments.changed') }),
  z.object({ type: z.literal('jobs.changed') }),
]);

export type ProjectEvent = z.infer<typeof projectEventSchema>;

export const projectSocketServerMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('hello'),
    self: z.object({ userId: z.string(), username: z.string(), displayName: z.string() }),
    members: z.array(presenceMemberSchema),
  }),
  z.object({ type: z.literal('presence'), members: z.array(presenceMemberSchema) }),
  z.object({
    type: z.literal('event'),
    at: z.string(),
    event: projectEventSchema,
  }),
]);

export type ProjectSocketServerMessage = z.infer<typeof projectSocketServerMessageSchema>;

export const projectSocketClientMessageSchema = z.discriminatedUnion('type', [
  presenceUpdateSchema,
]);

export type ProjectSocketClientMessage = z.infer<typeof projectSocketClientMessageSchema>;
