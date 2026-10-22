import { roleHasPermission, type ProjectRole } from '@platform/shared';

/**
 * What the current person may do in a project, for deciding what to render.
 *
 * The server enforces every one of these; the client asks only so a control it
 * knows will be refused is disabled with a reason instead of failing. One
 * definition, because two screens once answered "can write" differently.
 */

type MaybeRole = ProjectRole | null | undefined;

export function canWrite(role: MaybeRole): boolean {
  return role != null && roleHasPermission(role, 'file:write');
}

export function canControl(role: MaybeRole): boolean {
  return role != null && roleHasPermission(role, 'runtime:control');
}

export function canManage(role: MaybeRole): boolean {
  return role != null && roleHasPermission(role, 'member:manage');
}
