/**
 * Project authorization model.
 *
 * Roles are ordered: every capability of a lower role is held by the higher
 * ones. Authorization is enforced server-side; the frontend imports this only
 * to decide what to render, never to decide what is allowed.
 */
export const PROJECT_ROLES = ['VIEWER', 'EDITOR', 'OWNER'] as const;

export type ProjectRole = (typeof PROJECT_ROLES)[number];

const ROLE_RANK: Readonly<Record<ProjectRole, number>> = {
  VIEWER: 0,
  EDITOR: 1,
  OWNER: 2,
};

/**
 * Discrete capabilities checked at the service boundary. Named actions rather
 * than raw role comparisons so a permission change is a one-line edit here.
 */
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

/** Minimum role required for each capability. */
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

  /*
   * Seeing that a project has a database, and having its credentials, are one
   * capability rather than two.
   *
   * There is nothing useful to show without the connection details, and those
   * are a credential. An editor can change what a project does and still
   * cannot reach its data directly; the owner can.
   */
  'database:read': 'OWNER',
  /** Creating one spends the host's disk, and destroying one loses data. */
  'database:manage': 'OWNER',
  // Secret values are never readable; only the owner may set them.
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
