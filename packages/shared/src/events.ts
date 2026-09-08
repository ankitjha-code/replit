import { z } from 'zod';
import { RUNTIME_STATUSES } from './lifecycle.js';
import { presenceMemberSchema, presenceUpdateSchema } from './presence.js';
import { RUN_STATUSES } from './run.js';

/**
 * What is happening in a project, told to everyone looking at it.
 *
 * Until now every panel found out about a change by having made it, or by
 * polling. That is workable for one person and wrong for two: somebody else's
 * saved file, started container or new commit was invisible until you happened
 * to reload. This is the channel that fixes it.
 *
 * An event says what changed and never carries the change itself. A client is
 * told "a file was written" and asks for the file, rather than being handed
 * content over a socket whose authorization was decided once at upgrade. The
 * difference matters: a stream of content is a second, quieter API, and every
 * rule about who may read what would have to be enforced twice.
 *
 * Nor does an event say who did it. The roster on the same socket says who is
 * here, which is what a person actually wants to know; attributing every write
 * would mean the file service knowing which account is calling it, and it has
 * never needed to.
 */

/** The address of a project's event stream. */
export function projectEventsPath(projectId: string): string {
  return `/ws/projects/${encodeURIComponent(projectId)}/events`;
}

export function projectIdFromEventsPath(pathname: string): string | undefined {
  const match = /^\/ws\/projects\/([^/]+)\/events$/.exec(pathname);
  if (!match?.[1]) return undefined;
  return decodeURIComponent(match[1]);
}

/** Why a project's whole file set was replaced at once. */
export const BULK_FILE_REASONS = ['runtime-sync', 'restore'] as const;

export type BulkFileReason = (typeof BULK_FILE_REASONS)[number];

/** What part of a project's configuration changed. */
export const CONFIG_SCOPES = ['variables', 'secrets', 'database'] as const;

export type ConfigScope = (typeof CONFIG_SCOPES)[number];

export const projectEventSchema = z.discriminatedUnion('type', [
  /** One file was created or its content replaced. */
  z.object({ type: z.literal('file.written'), path: z.string() }),
  /** One path went away, with everything under it if it was a directory. */
  z.object({ type: z.literal('file.removed'), path: z.string() }),
  z.object({ type: z.literal('file.moved'), from: z.string(), to: z.string() }),
  /**
   * Many files at once, so a client should reload the tree rather than try to
   * follow along.
   */
  z.object({
    type: z.literal('files.replaced'),
    reason: z.enum(BULK_FILE_REASONS),
    created: z.number().int().nonnegative(),
    updated: z.number().int().nonnegative(),
    deleted: z.number().int().nonnegative(),
  }),
  /** The container behind the project started, stopped or failed. */
  z.object({ type: z.literal('runtime.changed'), status: z.enum(RUNTIME_STATUSES) }),
  /** The project's own application started or ended. */
  z.object({
    type: z.literal('run.changed'),
    status: z.enum(RUN_STATUSES),
    exitCode: z.number().int().nullable(),
  }),
  /** A snapshot was taken or discarded. */
  z.object({ type: z.literal('snapshots.changed') }),
  /** A commit was made. Null head means the history was removed. */
  z.object({ type: z.literal('history.changed'), headOid: z.string().nullable() }),
  /**
   * Configuration changed. Deliberately carries the scope and nothing else: a
   * secret's name is a hint about a secret.
   */
  z.object({ type: z.literal('config.changed'), scope: z.enum(CONFIG_SCOPES) }),
  /**
   * New output was written to the project's log.
   *
   * The fact and not the content, like every other event here: the log page
   * asks for what is new, and the server decides what the asker may read.
   */
  z.object({ type: z.literal('logs.appended') }),
  /**
   * Somebody was added, removed, or had their access changed.
   *
   * Carries the affected account, because this event has a job beyond telling a
   * page to reload: every socket that person holds on this project was
   * authorized under the access they had a moment ago, and a gateway seeing
   * this closes them. Their client reconnects and is authorized again from
   * scratch, which is the only honest way to apply a role that is decided at
   * upgrade.
   */
  z.object({ type: z.literal('members.changed'), userId: z.string() }),
  /** A deployment was requested, moved, stopped or removed. */
  z.object({ type: z.literal('deployments.changed') }),
  /**
   * Background work was queued, finished or failed.
   *
   * Carries nothing about which job. What a client does with this is reload the
   * list, and a page that tried to follow individual jobs would be reimplementing
   * the table it is looking at.
   */
  z.object({ type: z.literal('jobs.changed') }),
]);

export type ProjectEvent = z.infer<typeof projectEventSchema>;

/**
 * What the server sends on a project's event socket.
 *
 * Presence rides the same connection as events rather than having one of its
 * own. Two sockets would mean two authorizations, two heartbeats and two ways
 * to be half-connected, for one question: who is here and what changed.
 */
export const projectSocketServerMessageSchema = z.discriminatedUnion('type', [
  /**
   * Sent once, immediately, before anything else.
   *
   * Carries who the server thinks the client is, which lets the client leave
   * itself out of the roster it draws without having to guess.
   */
  z.object({
    type: z.literal('hello'),
    self: z.object({ userId: z.string(), username: z.string(), displayName: z.string() }),
    members: z.array(presenceMemberSchema),
  }),
  /** The roster changed: somebody arrived, left, or moved to another file. */
  z.object({ type: z.literal('presence'), members: z.array(presenceMemberSchema) }),
  /** Something happened in the project. */
  z.object({
    type: z.literal('event'),
    /** When the server published it, so a late client can order what it gets. */
    at: z.string(),
    event: projectEventSchema,
  }),
]);

export type ProjectSocketServerMessage = z.infer<typeof projectSocketServerMessageSchema>;

/**
 * What a client may send.
 *
 * One message, and it only ever describes the sender. Nothing on this socket
 * can change a project: everything that changes one goes through an HTTP route
 * where it is authorized per request.
 */
export const projectSocketClientMessageSchema = z.discriminatedUnion('type', [
  presenceUpdateSchema,
]);

export type ProjectSocketClientMessage = z.infer<typeof projectSocketClientMessageSchema>;
