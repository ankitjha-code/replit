import { z } from 'zod';
import { PROJECT_PERMISSIONS, PROJECT_ROLES } from './permissions.js';

/**
 * Project contracts.
 *
 * The same schemas validate the form in the browser and the request body on
 * the server. The client copy exists to give fast feedback; the server copy is
 * the one that decides.
 */

export const PROJECT_NAME_MAX_LENGTH = 100;
export const PROJECT_DESCRIPTION_MAX_LENGTH = 500;
/** Matches the column, and comfortably inside a DNS label for future hostnames. */
export const PROJECT_SLUG_MAX_LENGTH = 63;

/**
 * Slugs appear in URLs and will appear in per-project hostnames. Anything
 * outside this set would need escaping somewhere and eventually would not get
 * it.
 */
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9]))*$/;

/**
 * Slugs that would collide with platform paths or well-known hostnames.
 *
 * Shorter than the reserved username list because a slug is always scoped by
 * its owner in a URL. These are the ones that would still cause trouble.
 */
export const RESERVED_PROJECT_SLUGS: ReadonlySet<string> = new Set([
  'admin',
  'api',
  'app',
  'assets',
  'deploy',
  'health',
  'internal',
  'new',
  'preview',
  'settings',
  'static',
  'system',
  'ws',
  'www',
]);

export const projectSlugSchema = z
  .string()
  .trim()
  .min(1, 'Enter a slug')
  .max(PROJECT_SLUG_MAX_LENGTH, `Slug must be at most ${PROJECT_SLUG_MAX_LENGTH} characters`)
  .regex(SLUG_PATTERN, 'Slug may contain lowercase letters, numbers and single hyphens')
  .refine((value) => !RESERVED_PROJECT_SLUGS.has(value), 'That slug is reserved by the platform');

export const projectNameSchema = z
  .string()
  .trim()
  .min(1, 'Enter a name')
  .max(PROJECT_NAME_MAX_LENGTH, `Name must be at most ${PROJECT_NAME_MAX_LENGTH} characters`);

export const projectDescriptionSchema = z
  .string()
  .trim()
  .max(
    PROJECT_DESCRIPTION_MAX_LENGTH,
    `Description must be at most ${PROJECT_DESCRIPTION_MAX_LENGTH} characters`,
  );

/**
 * Turns a human name into a URL-safe slug.
 *
 * Shared so the browser can show the slug it expects while the user types, and
 * the server derives exactly the same one. Two implementations would drift and
 * the preview would start lying.
 *
 * Returns an empty string when nothing usable survives, which the caller
 * handles; silently substituting a placeholder here would hide the case where
 * a name is entirely non-Latin and the user should be asked for a slug.
 */
export function slugify(name: string): string {
  return (
    name
      .normalize('NFKD')
      // Strip combining marks so an accented letter becomes its base letter
      // rather than being dropped entirely.
      .replace(/\p{M}/gu, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, PROJECT_SLUG_MAX_LENGTH)
      // Truncation can leave a trailing hyphen.
      .replace(/-+$/, '')
  );
}

export const createProjectRequestSchema = z.object({
  name: projectNameSchema,
  description: projectDescriptionSchema.optional(),
  /**
   * Optional. When absent the server derives one from the name, so a person
   * never has to think about URLs to make a project.
   */
  slug: projectSlugSchema.optional(),
});

export type CreateProjectRequest = z.infer<typeof createProjectRequestSchema>;

/**
 * Renaming a project, or changing what it says about itself.
 *
 * The slug is deliberately **not** here. It is in every URL anybody has
 * bookmarked or shared, and changing it would break all of them at once; the
 * name is what a person reads, and it can change as often as they like. A
 * description of null clears it.
 */
export const updateProjectRequestSchema = z
  .object({
    name: projectNameSchema.optional(),
    description: projectDescriptionSchema.nullable().optional(),
  })
  .refine((value) => value.name !== undefined || value.description !== undefined, {
    message: 'Say what to change',
  });

export type UpdateProjectRequest = z.infer<typeof updateProjectRequestSchema>;

export const projectRoleSchema = z.enum(PROJECT_ROLES);

export const projectSummarySchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  /** The caller's own access, so a list can show what they may do with each. */
  role: projectRoleSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type ProjectSummary = z.infer<typeof projectSummarySchema>;

export const projectResponseSchema = z.object({
  project: projectSummarySchema,
});

export type ProjectResponse = z.infer<typeof projectResponseSchema>;

export const projectListResponseSchema = z.object({
  projects: z.array(projectSummarySchema),
});

export type ProjectListResponse = z.infer<typeof projectListResponseSchema>;

export const projectMemberSchema = z.object({
  userId: z.string(),
  username: z.string(),
  displayName: z.string().nullable(),
  role: projectRoleSchema,
  joinedAt: z.string(),
});

export type ProjectMemberView = z.infer<typeof projectMemberSchema>;

export const projectMembersResponseSchema = z.object({
  members: z.array(projectMemberSchema),
  /**
   * What the caller may do, resolved server-side from their own role.
   *
   * Sent so the client can hide actions it would not be allowed to take. It is
   * a rendering hint and nothing more: every action is checked again on the
   * server, which is what actually decides.
   */
  viewerPermissions: z.array(z.enum(PROJECT_PERMISSIONS)),
});

export type ProjectMembersResponse = z.infer<typeof projectMembersResponseSchema>;

/**
 * Changing who may reach a project.
 *
 * Somebody is added by username rather than by identifier: a username is the
 * only thing about another account a person can be expected to know, and the
 * only thing the platform shows them. An identifier in this request would mean
 * a way to look one up, which is a way to enumerate accounts.
 */
export const addProjectMemberRequestSchema = z.object({
  username: z
    .string()
    .trim()
    .min(1, 'Enter the username of the person to add')
    .max(39, 'That is longer than any username'),
  /**
   * Owner is offered, because a project with one owner is a project that dies
   * with its owner's account. Nothing prevents a second one.
   */
  role: projectRoleSchema,
});

export type AddProjectMemberRequest = z.infer<typeof addProjectMemberRequestSchema>;

export const updateProjectMemberRequestSchema = z.object({
  role: projectRoleSchema,
});

export type UpdateProjectMemberRequest = z.infer<typeof updateProjectMemberRequestSchema>;

export const projectMemberResponseSchema = z.object({ member: projectMemberSchema });

export type ProjectMemberResponse = z.infer<typeof projectMemberResponseSchema>;
