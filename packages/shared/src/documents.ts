import { z } from 'zod';

export function documentPath(projectId: string, path: string): string {
  return `/ws/projects/${encodeURIComponent(projectId)}/document?path=${encodeURIComponent(path)}`;
}

export function projectIdFromDocumentPath(pathname: string): string | undefined {
  const match = /^\/ws\/projects\/([^/]+)\/document$/.exec(pathname);
  if (!match?.[1]) return undefined;
  return decodeURIComponent(match[1]);
}

export const DOCUMENT_SYNC_STEP_1 = 0;
export const DOCUMENT_SYNC_STEP_2 = 1;
export const DOCUMENT_UPDATE = 2;
export const DOCUMENT_AWARENESS = 3;

export const MAX_AWARENESS_BYTES = 4 * 1024;

export function participantColour(userId: string): string {
  let hash = 0;
  for (const character of userId) hash = (Math.imul(hash, 31) + character.charCodeAt(0)) | 0;
  const hue = Math.abs(hash) % 360;
  return `hsl(${String(hue)}, 70%, 45%)`;
}

export const DOCUMENT_MAX_MESSAGE_BYTES = 4 * 1024 * 1024;

export const DOCUMENT_ERROR_CODES = [
  'NOT_FOUND',
  'UNSUPPORTED',
  'READ_ONLY',
  'TOO_MANY_DOCUMENTS',
  'STORAGE_FAILED',
] as const;

export type DocumentErrorCode = (typeof DOCUMENT_ERROR_CODES)[number];

export const documentParticipantSchema = z.object({
  userId: z.string(),
  username: z.string(),
  displayName: z.string(),
  canWrite: z.boolean(),
});

export type DocumentParticipant = z.infer<typeof documentParticipantSchema>;

export const documentServerMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('ready'),
    path: z.string(),
    canWrite: z.boolean(),
    participants: z.array(documentParticipantSchema),
  }),
  z.object({
    type: z.literal('participants'),
    participants: z.array(documentParticipantSchema),
  }),
  z.object({
    type: z.literal('saved'),
    at: z.string(),
    version: z.number().int().positive(),
  }),
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

export const documentClientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ping') }),
]);

export type DocumentClientMessage = z.infer<typeof documentClientMessageSchema>;
