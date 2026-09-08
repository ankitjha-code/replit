import { describe, expect, it } from 'vitest';
import {
  PROJECT_PERMISSIONS,
  permissionsForRole,
  roleHasPermission,
  roleSatisfies,
} from './permissions.js';

describe('project roles', () => {
  it('orders viewer below editor below owner', () => {
    expect(roleSatisfies('OWNER', 'EDITOR')).toBe(true);
    expect(roleSatisfies('EDITOR', 'VIEWER')).toBe(true);
    expect(roleSatisfies('VIEWER', 'EDITOR')).toBe(false);
    expect(roleSatisfies('EDITOR', 'OWNER')).toBe(false);
  });

  it('gives a viewer read access but no writes', () => {
    expect(roleHasPermission('VIEWER', 'file:read')).toBe(true);
    expect(roleHasPermission('VIEWER', 'file:write')).toBe(false);
    expect(roleHasPermission('VIEWER', 'runtime:control')).toBe(false);
  });

  it('withholds secrets from editors', () => {
    expect(roleHasPermission('EDITOR', 'secret:read')).toBe(false);
    expect(roleHasPermission('EDITOR', 'secret:write')).toBe(false);
    expect(roleHasPermission('OWNER', 'secret:write')).toBe(true);
  });

  it('withholds deletion and member management from editors', () => {
    expect(roleHasPermission('EDITOR', 'project:delete')).toBe(false);
    expect(roleHasPermission('EDITOR', 'member:manage')).toBe(false);
  });

  it('grants an owner every permission', () => {
    expect(permissionsForRole('OWNER')).toEqual([...PROJECT_PERMISSIONS]);
  });

  it('nests role capabilities', () => {
    const viewer = permissionsForRole('VIEWER');
    const editor = permissionsForRole('EDITOR');
    for (const permission of viewer) {
      expect(editor).toContain(permission);
    }
  });
});
