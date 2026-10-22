import { z } from 'zod';

/**
 * The terminal protocol.
 *
 * One WebSocket per terminal, carrying JSON text frames in both directions.
 * JSON rather than a raw byte stream because the connection carries more than
 * output: a resize is not data the shell should see, and an exit is not text.
 * A single framing for everything means neither side has to guess what a
 * message is.
 *
 * Both directions are validated against these schemas. The client's messages
 * are attacker-controlled, and the server's are what a browser will act on, so
 * neither is trusted because of where it came from.
 */

/** How large the terminal is, in character cells. */
export const terminalSizeSchema = z.object({
  /**
   * Bounded because these numbers become a pseudo-terminal's dimensions. A
   * client asking for a million columns is not resizing a window.
   */
  columns: z.number().int().min(1).max(1000),
  rows: z.number().int().min(1).max(1000),
});

export type TerminalSize = z.infer<typeof terminalSizeSchema>;

export const DEFAULT_TERMINAL_SIZE: TerminalSize = { columns: 80, rows: 24 };

/**
 * Largest single chunk of keyboard input accepted.
 *
 * Generous for a paste, small enough that a client cannot use one frame to
 * make the server hold an arbitrary amount of memory.
 */
export const MAX_INPUT_BYTES = 64 * 1024;

export const clientMessageSchema = z.discriminatedUnion('type', [
  /** Keystrokes, or a paste. Sent to the process's standard input verbatim. */
  z.object({
    type: z.literal('input'),
    data: z.string().max(MAX_INPUT_BYTES),
  }),
  /** The window changed size. */
  z.object({
    type: z.literal('resize'),
    size: terminalSizeSchema,
  }),
]);

export type TerminalClientMessage = z.infer<typeof clientMessageSchema>;

/** Why a terminal could not be opened, or stopped working. */
export const TERMINAL_ERROR_CODES = [
  'RUNTIME_NOT_RUNNING',
  'RUNTIME_UNAVAILABLE',
  'FORBIDDEN',
  'TOO_MANY_TERMINALS',
  'EXECUTION_FAILED',
  /** The session asked for is gone: it ended, was reaped, or never existed. */
  'SESSION_NOT_FOUND',
  /**
   * Another socket resumed this session.
   *
   * Not a failure. A session has one screen, and two sockets writing to one
   * shell would interleave their keystrokes into nonsense, so the newer one
   * wins and the older is told why it stopped rather than just going quiet.
   */
  'SESSION_TAKEN_OVER',
] as const;

export type TerminalErrorCode = (typeof TERMINAL_ERROR_CODES)[number];

export const serverMessageSchema = z.discriminatedUnion('type', [
  /**
   * The shell is attached and anything held while connecting has been sent.
   *
   * Carries the session's identity, because the client cannot ask for a
   * session again without knowing which one it got. `resumed` distinguishes
   * a shell that was already there from one opened just now, and `truncated`
   * says that the replay which follows is not everything the shell printed.
   */
  z.object({
    type: z.literal('ready'),
    sessionId: z.string(),
    resumed: z.boolean(),
    truncated: z.boolean(),
  }),
  /** Bytes the process produced, already decoded as UTF-8. */
  z.object({ type: z.literal('output'), data: z.string() }),
  /** The process ended. The socket closes straight after. */
  z.object({ type: z.literal('exit'), code: z.number().int().nullable() }),
  /**
   * Something went wrong, said in words a person can act on.
   *
   * Carries a code as well, so the client can distinguish "start the project
   * first" from "you are not allowed" without reading the prose.
   */
  z.object({
    type: z.literal('error'),
    code: z.enum(TERMINAL_ERROR_CODES),
    message: z.string(),
  }),
]);

export type TerminalServerMessage = z.infer<typeof serverMessageSchema>;

/**
 * The address of a project's terminal.
 *
 * With a session identifier it asks to resume that shell; without one it asks
 * for a new shell. The identifier travels in the query rather than the path so
 * that route matching stays exact: one route, whose shape cannot be changed by
 * what the client wants to do on it.
 */
export function terminalPath(projectId: string, sessionId?: string): string {
  const base = `/ws/projects/${encodeURIComponent(projectId)}/terminal`;
  return sessionId ? `${base}?session=${encodeURIComponent(sessionId)}` : base;
}

/**
 * The session a socket is asking to resume, if it asked for one.
 *
 * Returns undefined for an absent, empty or unusable value, so a malformed
 * query opens a new shell rather than being refused. The identifier is checked
 * against what actually exists a moment later, and that is the check that
 * matters.
 */
export function sessionIdFromTerminalUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  // Read by hand rather than with URL, which this package cannot assume: it is
  // shared by a browser bundle and a server, and its lib is deliberately the
  // language only.
  const match = /[?&]session=([^&#]*)/.exec(url);
  if (!match?.[1]) return undefined;
  let value: string;
  try {
    value = decodeURIComponent(match[1]);
  } catch {
    // A malformed escape is not an identifier. Opening a new shell is the
    // right answer; it is checked against what exists either way.
    return undefined;
  }
  return value.length > 0 && value.length <= 100 ? value : undefined;
}

/**
 * One shell a person has open in a project, as the API reports it.
 *
 * The server is what knows which sessions exist. A browser that reloaded has
 * forgotten, and a browser that remembers may be wrong, so the list is asked
 * for rather than reconstructed from anything the client kept.
 */
export const terminalSessionSummarySchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  lastActiveAt: z.string(),
  /** Whether a socket is on it right now. */
  attached: z.boolean(),
  size: terminalSizeSchema,
});

export type TerminalSessionSummary = z.infer<typeof terminalSessionSummarySchema>;

export const terminalSessionsResponseSchema = z.object({
  sessions: z.array(terminalSessionSummarySchema),
});

export type TerminalSessionsResponse = z.infer<typeof terminalSessionsResponseSchema>;

/**
 * Reads a project identifier back out of a terminal path.
 *
 * Returns undefined for anything that is not exactly this route, so a
 * near-miss is refused rather than being coerced into something plausible.
 */
export function projectIdFromTerminalPath(pathname: string): string | undefined {
  const match = /^\/ws\/projects\/([^/]+)\/terminal$/.exec(pathname);
  if (!match?.[1]) return undefined;
  return decodeURIComponent(match[1]);
}
