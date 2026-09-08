import { z } from 'zod';

/**
 * Collaborative editing of one file.
 *
 * Two people typing in the same file is the one thing in this platform that
 * cannot be resolved by asking who wrote last. Every other concurrent change —
 * two saves, two starts, two commits — has a moment where one of them is
 * simply earlier. Characters do not: "insert X at position 4" means something
 * different depending on what arrived in between.
 *
 * So the text is a CRDT (a Yjs document), and this describes the socket that
 * carries it. The platform holds the authoritative document in memory while
 * anybody has the file open, and writes it back to the project's files as the
 * typing settles. The database stays the source of truth for what a project
 * contains; the shared document is a live working copy of one file in it.
 *
 * The socket carries two kinds of frame, and the distinction is the transport's
 * own rather than something invented here:
 *
 *  - **Binary frames** are document sync, a one-byte type followed by an opaque
 *    Yjs payload. Nothing outside the CRDT library interprets them.
 *  - **Text frames** are JSON control messages, described below.
 *
 * Two framings on one socket, rather than base64 inside JSON, because a
 * document update is bytes and encoding it as text would inflate every
 * keystroke by a third for no benefit.
 */

/** The address of a project's shared document for one path. */
export function documentPath(projectId: string, path: string): string {
  return `/ws/projects/${encodeURIComponent(projectId)}/document?path=${encodeURIComponent(path)}`;
}

export function projectIdFromDocumentPath(pathname: string): string | undefined {
  const match = /^\/ws\/projects\/([^/]+)\/document$/.exec(pathname);
  if (!match?.[1]) return undefined;
  return decodeURIComponent(match[1]);
}

/**
 * The first byte of a binary frame.
 *
 * The handshake is the standard two-step one: each side sends what it already
 * has (a state vector), and each replies with exactly what the other is
 * missing. It is symmetrical because either side may be the one that is behind
 * — a client reconnecting after a lost connection is ahead of nothing and
 * behind everything, and a server that has just loaded a file from the database
 * is behind every client still holding unsaved characters.
 */
export const DOCUMENT_SYNC_STEP_1 = 0;
export const DOCUMENT_SYNC_STEP_2 = 1;
export const DOCUMENT_UPDATE = 2;
/**
 * Where everybody's cursor and selection are.
 *
 * A Yjs awareness update, and — unlike the document frames — something the
 * server does not simply relay: every field in it is client-supplied, so the
 * server re-stamps each participant's name and colour from the authenticated
 * account and refuses updates that touch somebody else's identity.
 */
export const DOCUMENT_AWARENESS = 3;

/** Largest awareness frame accepted. A cursor is a few dozen bytes. */
export const MAX_AWARENESS_BYTES = 4 * 1024;

/**
 * A stable colour for an account, from its identifier.
 *
 * Derived on the server and sent to everybody, so two people see a collaborator
 * in the same colour, and nobody can choose their own — a chosen colour is a
 * string a client controls, and it ends up in a stylesheet.
 */
export function participantColour(userId: string): string {
  let hash = 0;
  for (const character of userId) hash = (Math.imul(hash, 31) + character.charCodeAt(0)) | 0;
  const hue = Math.abs(hash) % 360;
  return `hsl(${String(hue)}, 70%, 45%)`;
}

/**
 * The largest single frame the document socket accepts.
 *
 * A sync reply can carry a whole file, so this has to exceed the largest file
 * the editor will open, with room for the CRDT's own bookkeeping. Bounded all
 * the same: an unbounded frame is an unbounded allocation.
 */
export const DOCUMENT_MAX_MESSAGE_BYTES = 4 * 1024 * 1024;

/** Why a document could not be opened, or stopped being editable. */
export const DOCUMENT_ERROR_CODES = [
  /** No such file, or it is a directory. */
  'NOT_FOUND',
  /** Not text, or too large for the editor. */
  'UNSUPPORTED',
  /** The caller may read the project but not write it. */
  'READ_ONLY',
  /** Too many files open at once in this project. */
  'TOO_MANY_DOCUMENTS',
  /** The platform could not load or could not save the file. */
  'STORAGE_FAILED',
] as const;

export type DocumentErrorCode = (typeof DOCUMENT_ERROR_CODES)[number];

export const documentParticipantSchema = z.object({
  userId: z.string(),
  username: z.string(),
  displayName: z.string(),
  /** False for somebody watching a file they may not change. */
  canWrite: z.boolean(),
});

export type DocumentParticipant = z.infer<typeof documentParticipantSchema>;

export const documentServerMessageSchema = z.discriminatedUnion('type', [
  /**
   * The document is open. Sent before the first sync frame.
   *
   * `canWrite` is the server's answer and not the client's guess. A client that
   * believed otherwise would let somebody type into a buffer whose changes are
   * discarded, which is worse than a read-only editor.
   */
  z.object({
    type: z.literal('ready'),
    path: z.string(),
    canWrite: z.boolean(),
    participants: z.array(documentParticipantSchema),
  }),
  /** Somebody opened or closed this file. */
  z.object({
    type: z.literal('participants'),
    participants: z.array(documentParticipantSchema),
  }),
  /** The platform wrote the document back to the project. */
  z.object({
    type: z.literal('saved'),
    at: z.string(),
    version: z.number().int().positive(),
  }),
  /**
   * The file changed underneath this session, so it is no longer being saved.
   *
   * Happens when something outside the editor rewrites the file: a restore, a
   * read-back from a container, or a write through the API. The session stops
   * persisting rather than overwriting that change, and says so. Nothing typed
   * is lost — it is still in every open editor — but it is no longer being
   * written down, and a person has to be told that rather than left to find out.
   */
  z.object({
    type: z.literal('stale'),
    message: z.string(),
  }),
  z.object({
    type: z.literal('error'),
    code: z.enum(DOCUMENT_ERROR_CODES),
    message: z.string(),
  }),
]);

export type DocumentServerMessage = z.infer<typeof documentServerMessageSchema>;

/**
 * What a client may say in a text frame.
 *
 * Nothing, so far. Editing travels as binary sync frames, and everything else
 * about a document is the server's to decide. The schema exists so that the
 * socket has one place to grow a control message and one place that already
 * refuses everything else.
 */
export const documentClientMessageSchema = z.discriminatedUnion('type', [
  /** Keeps a session alive across a network that drops idle connections. */
  z.object({ type: z.literal('ping') }),
]);

export type DocumentClientMessage = z.infer<typeof documentClientMessageSchema>;
