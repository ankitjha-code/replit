export const PROJECT_ROLES = ['VIEWER', 'EDITOR', 'OWNER'] as const;

export type ProjectRole = (typeof PROJECT_ROLES)[number];

const ROLE_RANK: Readonly<Record<ProjectRole, number>> = {
  VIEWER: 0,
  EDITOR: 1,
  OWNER: 2,
};

export const PROJECT_PERMISSIONS = [
  'project:read',
  'project:update',
  'project:delete',
  'file:read',
  'file:write',
  'runtime:read',
  'runtime:control',
  'terminal:attach',
  'env:read',
  'env:write',
  'database:read',
  'database:manage',
  'secret:read',
  'secret:write',
  'storage:read',
  'storage:write',
  'version:read',
  'version:write',
  'deployment:read',
  'deployment:control',
  'member:read',
  'member:manage',
] as const;

export type ProjectPermission = (typeof PROJECT_PERMISSIONS)[number];

const REQUIRED_ROLE: Readonly<Record<ProjectPermission, ProjectRole>> = {
  'project:read': 'VIEWER',
  'project:update': 'EDITOR',
  'project:delete': 'OWNER',
  'file:read': 'VIEWER',
  'file:write': 'EDITOR',
  'runtime:read': 'VIEWER',
  'runtime:control': 'EDITOR',
  'terminal:attach': 'EDITOR',
  'env:read': 'EDITOR',
  'env:write': 'EDITOR',

  'database:read': 'OWNER',
  'database:manage': 'OWNER',
  'secret:read': 'OWNER',
  'secret:write': 'OWNER',
  'storage:read': 'VIEWER',
  'storage:write': 'EDITOR',
  'version:read': 'VIEWER',
  'version:write': 'EDITOR',
  'deployment:read': 'VIEWER',
  'deployment:control': 'OWNER',
  'member:read': 'VIEWER',
  'member:manage': 'OWNER',
};

export function roleSatisfies(role: ProjectRole, minimum: ProjectRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[minimum];
}

export function roleHasPermission(role: ProjectRole, permission: ProjectPermission): boolean {
  return roleSatisfies(role, REQUIRED_ROLE[permission]);
}

export function permissionsForRole(role: ProjectRole): ProjectPermission[] {
  return PROJECT_PERMISSIONS.filter((p) => roleHasPermission(role, p));
}
