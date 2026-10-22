import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PROJECT_PERMISSIONS, type ProjectPermission, type ProjectRole } from '@platform/shared';
import type { AppError } from '../../errors/app-error.js';
import { AuthorizationService } from './authorization.service.js';
import type { MembershipRecord, ProjectRecord, ProjectRepository } from './project.repository.js';

const PROJECT: ProjectRecord = {
  id: 'project-1',
  slug: 'analytical-engine',
  name: 'Analytical Engine',
  description: null,
  ownerId: 'owner',
  runCommand: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
};

const membership = (userId: string, role: ProjectRole): MembershipRecord => ({
  id: `membership-${userId}`,
  projectId: PROJECT.id,
  userId,
  role,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
});

/**
 * In-memory membership table.
 *
 * The decision under test is which refusal a given combination produces, which
 * needs no database. The same rules are exercised against a real one in the
 * integration suite.
 */
class FakeProjectRepository {
  projects = new Map<string, ProjectRecord>([[PROJECT.id, PROJECT]]);
  memberships: MembershipRecord[] = [];

  findWithMembership = vi.fn(async (projectId: string, userId: string) => {
    const project = this.projects.get(projectId);
    if (!project) return null;
    return {
      project,
      membership:
        this.memberships.find((m) => m.projectId === projectId && m.userId === userId) ?? null,
    };
  });

  findMembership = vi.fn(
    async (projectId: string, userId: string) =>
      this.memberships.find((m) => m.projectId === projectId && m.userId === userId) ?? null,
  );
}

let repository: FakeProjectRepository;
let service: AuthorizationService;

const attempt = async (
  userId: string,
  permission: ProjectPermission,
  projectId = PROJECT.id,
): Promise<AppError> =>
  (await service.authorize(userId, projectId, permission).catch((e: unknown) => e)) as AppError;

beforeEach(() => {
  repository = new FakeProjectRepository();
  service = new AuthorizationService(repository as unknown as ProjectRepository);
});

describe('granting access', () => {
  it('lets an owner do anything', async () => {
    repository.memberships.push(membership('ada', 'OWNER'));

    for (const permission of PROJECT_PERMISSIONS) {
      await expect(service.authorize('ada', PROJECT.id, permission)).resolves.toBeDefined();
    }
  });

  it('returns the project and the caller role', async () => {
    repository.memberships.push(membership('ada', 'EDITOR'));

    const access = await service.authorize('ada', PROJECT.id, 'file:write');
    expect(access.project.id).toBe(PROJECT.id);
    expect(access.role).toBe('EDITOR');
  });

  it('lets an editor write files and control the runtime', async () => {
    repository.memberships.push(membership('ada', 'EDITOR'));

    await expect(service.authorize('ada', PROJECT.id, 'file:write')).resolves.toBeDefined();
    await expect(service.authorize('ada', PROJECT.id, 'runtime:control')).resolves.toBeDefined();
  });

  it('lets a viewer read', async () => {
    repository.memberships.push(membership('ada', 'VIEWER'));
    await expect(service.authorize('ada', PROJECT.id, 'file:read')).resolves.toBeDefined();
  });
});

describe('refusing access', () => {
  it('answers 404 when the project does not exist', async () => {
    const error = await attempt('ada', 'project:read', 'no-such-project');
    expect(error.code).toBe('NOT_FOUND');
  });

  it('answers 404 when the caller is not a member', async () => {
    // Not 403. A 403 would confirm the project exists, which lets anyone walk
    // identifiers and learn what other people are working on.
    const error = await attempt('stranger', 'project:read');
    expect(error.code).toBe('NOT_FOUND');
  });

  it('gives a stranger the same answer for a real and an imaginary project', async () => {
    const real = await attempt('stranger', 'project:read');
    const imaginary = await attempt('stranger', 'project:read', 'no-such-project');

    expect(imaginary.code).toBe(real.code);
    expect(imaginary.message).toBe(real.message);
    expect(imaginary.status).toBe(real.status);
  });

  it('answers 403 when a member lacks the capability', async () => {
    // They already know it exists, so there is nothing left to hide, and a 404
    // would be misleading to someone looking straight at the project.
    repository.memberships.push(membership('ada', 'VIEWER'));

    const error = await attempt('ada', 'file:write');
    expect(error.code).toBe('FORBIDDEN');
  });

  it('says which capability was required', async () => {
    repository.memberships.push(membership('ada', 'VIEWER'));
    const error = await attempt('ada', 'runtime:control');
    expect(error.details).toEqual({ required: 'runtime:control', role: 'VIEWER' });
  });

  it('refuses a viewer every write', async () => {
    repository.memberships.push(membership('ada', 'VIEWER'));

    for (const permission of ['file:write', 'runtime:control', 'storage:write'] as const) {
      expect((await attempt('ada', permission)).code).toBe('FORBIDDEN');
    }
  });

  it('refuses an editor the owner-only capabilities', async () => {
    repository.memberships.push(membership('ada', 'EDITOR'));

    for (const permission of [
      'project:delete',
      'member:manage',
      'secret:read',
      'secret:write',
      'deployment:control',
    ] as const) {
      expect((await attempt('ada', permission)).code).toBe('FORBIDDEN');
    }
  });

  it('never leaks the caller or project into the message', async () => {
    repository.memberships.push(membership('ada', 'VIEWER'));
    const error = await attempt('ada', 'secret:read');
    expect(error.message).not.toContain('ada');
    expect(error.message).not.toContain(PROJECT.id);
  });

  it('does not let one project membership grant access to another', async () => {
    const other: ProjectRecord = { ...PROJECT, id: 'project-2', slug: 'other' };
    repository.projects.set(other.id, other);
    repository.memberships.push(membership('ada', 'OWNER'));

    expect((await attempt('ada', 'project:read', other.id)).code).toBe('NOT_FOUND');
  });
});

describe('can', () => {
  it('answers true without throwing when allowed', async () => {
    repository.memberships.push(membership('ada', 'EDITOR'));
    await expect(service.can('ada', PROJECT.id, 'file:write')).resolves.toBe(true);
  });

  it('answers false rather than throwing when refused', async () => {
    repository.memberships.push(membership('ada', 'VIEWER'));
    await expect(service.can('ada', PROJECT.id, 'file:write')).resolves.toBe(false);
  });

  it('answers false for a non-member', async () => {
    await expect(service.can('stranger', PROJECT.id, 'project:read')).resolves.toBe(false);
  });
});
