import { z } from 'zod';
import { PROJECT_PERMISSIONS, PROJECT_ROLES } from './permissions.js';

export const PROJECT_NAME_MAX_LENGTH = 100;
export const PROJECT_DESCRIPTION_MAX_LENGTH = 500;
export const PROJECT_SLUG_MAX_LENGTH = 63;

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9]))*$/;

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

export function slugify(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, PROJECT_SLUG_MAX_LENGTH)
    .replace(/-+$/, '');
}

export const createProjectRequestSchema = z.object({
  name: projectNameSchema,
  description: projectDescriptionSchema.optional(),
  slug: projectSlugSchema.optional(),
});

export type CreateProjectRequest = z.infer<typeof createProjectRequestSchema>;

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
  viewerPermissions: z.array(z.enum(PROJECT_PERMISSIONS)),
});

export type ProjectMembersResponse = z.infer<typeof projectMembersResponseSchema>;

export const addProjectMemberRequestSchema = z.object({
  username: z
    .string()
    .trim()
    .min(1, 'Enter the username of the person to add')
    .max(39, 'That is longer than any username'),
  role: projectRoleSchema,
});

export type AddProjectMemberRequest = z.infer<typeof addProjectMemberRequestSchema>;

export const updateProjectMemberRequestSchema = z.object({
  role: projectRoleSchema,
});

export type UpdateProjectMemberRequest = z.infer<typeof updateProjectMemberRequestSchema>;

export const projectMemberResponseSchema = z.object({ member: projectMemberSchema });

export type ProjectMemberResponse = z.infer<typeof projectMemberResponseSchema>;
