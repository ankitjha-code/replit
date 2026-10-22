import { roleHasPermission, type ProjectRole } from '@platform/shared';

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
