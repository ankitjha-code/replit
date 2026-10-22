import { z } from 'zod';

export const terminalSizeSchema = z.object({
  columns: z.number().int().min(1).max(1000),
  rows: z.number().int().min(1).max(1000),
});

export type TerminalSize = z.infer<typeof terminalSizeSchema>;

export const DEFAULT_TERMINAL_SIZE: TerminalSize = { columns: 80, rows: 24 };

export const MAX_INPUT_BYTES = 64 * 1024;

export const clientMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('input'),
    data: z.string().max(MAX_INPUT_BYTES),
  }),
  z.object({
    type: z.literal('resize'),
    size: terminalSizeSchema,
  }),
]);

export type TerminalClientMessage = z.infer<typeof clientMessageSchema>;

export const TERMINAL_ERROR_CODES = [
  'RUNTIME_NOT_RUNNING',
  'RUNTIME_UNAVAILABLE',
  'FORBIDDEN',
  'TOO_MANY_TERMINALS',
  'EXECUTION_FAILED',
  'SESSION_NOT_FOUND',
  'SESSION_TAKEN_OVER',
] as const;

export type TerminalErrorCode = (typeof TERMINAL_ERROR_CODES)[number];

export const serverMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('ready'),
    sessionId: z.string(),
    resumed: z.boolean(),
    truncated: z.boolean(),
  }),
  z.object({ type: z.literal('output'), data: z.string() }),
  z.object({ type: z.literal('exit'), code: z.number().int().nullable() }),
  z.object({
    type: z.literal('error'),
    code: z.enum(TERMINAL_ERROR_CODES),
    message: z.string(),
  }),
]);

export type TerminalServerMessage = z.infer<typeof serverMessageSchema>;

export function terminalPath(projectId: string, sessionId?: string): string {
  const base = `/ws/projects/${encodeURIComponent(projectId)}/terminal`;
  return sessionId ? `${base}?session=${encodeURIComponent(sessionId)}` : base;
}

export function sessionIdFromTerminalUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const match = /[?&]session=([^&#]*)/.exec(url);
  if (!match?.[1]) return undefined;
  let value: string;
  try {
    value = decodeURIComponent(match[1]);
  } catch {
    return undefined;
  }
  return value.length > 0 && value.length <= 100 ? value : undefined;
}

export const terminalSessionSummarySchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  lastActiveAt: z.string(),
  attached: z.boolean(),
  size: terminalSizeSchema,
});

export type TerminalSessionSummary = z.infer<typeof terminalSessionSummarySchema>;

export const terminalSessionsResponseSchema = z.object({
  sessions: z.array(terminalSessionSummarySchema),
});

export type TerminalSessionsResponse = z.infer<typeof terminalSessionsResponseSchema>;

export function projectIdFromTerminalPath(pathname: string): string | undefined {
  const match = /^\/ws\/projects\/([^/]+)\/terminal$/.exec(pathname);
  if (!match?.[1]) return undefined;
  return decodeURIComponent(match[1]);
}
