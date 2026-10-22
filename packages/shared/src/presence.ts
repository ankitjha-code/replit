import { z } from 'zod';

export const MAX_PRESENCE_PATH_LENGTH = 1024;

export const presenceMemberSchema = z.object({
  userId: z.string(),
  username: z.string(),
  displayName: z.string(),
  file: z.string().nullable(),
  since: z.string(),
  connections: z.number().int().positive(),
});

export type PresenceMember = z.infer<typeof presenceMemberSchema>;

export const presenceUpdateSchema = z.object({
  type: z.literal('presence'),
  file: z.string().max(MAX_PRESENCE_PATH_LENGTH).nullable(),
});

export type PresenceUpdate = z.infer<typeof presenceUpdateSchema>;
