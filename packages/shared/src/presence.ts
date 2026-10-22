import { z } from 'zod';

/**
 * Who else has this project open.
 *
 * Presence is not membership. A member is a row in a table and outlives every
 * session; a presence is somebody who is here right now, and it exists only in
 * the memory of the process holding their socket. Nothing here is stored, and
 * nothing here survives a restart, which is correct: after a restart nobody is
 * connected, so the honest roster is empty.
 *
 * Aggregated by person rather than by socket. Somebody with the workspace open
 * in two tabs is one person in the room, and a roster that said otherwise
 * would be counting windows.
 */

/**
 * The longest path presence will carry.
 *
 * Presence is repeated on every file change, so the frame has to stay small;
 * and a path longer than this is not a path the file service would have
 * accepted in the first place.
 */
export const MAX_PRESENCE_PATH_LENGTH = 1024;

export const presenceMemberSchema = z.object({
  /**
   * The user's identifier.
   *
   * Sent because the client has to key a list on something stable, and a
   * username can in principle be changed. It identifies an account that is
   * already a member of a project the recipient can see, so it discloses
   * nothing they could not already ask for.
   */
  userId: z.string(),
  username: z.string(),
  /** What to show. Falls back to the username when nobody set one. */
  displayName: z.string(),
  /**
   * The file they are looking at, or null when they are not in one.
   *
   * Best effort by definition: it is whatever their client last said, and a
   * client that says nothing is shown as simply present.
   */
  file: z.string().nullable(),
  /** When they arrived, so a roster can be ordered by who has been here longest. */
  since: z.string(),
  /** How many of their windows are open. One person, several tabs. */
  connections: z.number().int().positive(),
});

export type PresenceMember = z.infer<typeof presenceMemberSchema>;

/**
 * What a client says about itself.
 *
 * The only thing a client may assert. It cannot claim to be somebody else:
 * identity comes from the session on the socket's own upgrade, and this frame
 * carries no user at all.
 */
export const presenceUpdateSchema = z.object({
  type: z.literal('presence'),
  file: z.string().max(MAX_PRESENCE_PATH_LENGTH).nullable(),
});

export type PresenceUpdate = z.infer<typeof presenceUpdateSchema>;
