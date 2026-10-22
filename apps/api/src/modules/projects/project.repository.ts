import type { ProjectRole } from '@platform/shared';
import type { Database } from '../../db/client.js';

/**
 * The only code that reads or writes the projects and project_members tables.
 *
 * No authorization decisions here. This layer answers "what is the state" and
 * the service above decides what that means for a given request.
 */

export interface ProjectRecord {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  ownerId: string;
  /** How the project starts. Null means the platform suggests one. */
  runCommand: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface MembershipRecord {
  id: string;
  projectId: string;
  userId: string;
  role: ProjectRole;
  createdAt: Date;
  updatedAt: Date;
}

export interface MemberWithUser extends MembershipRecord {
  user: { id: string; username: string; displayName: string | null };
}

export interface CreateProjectInput {
  slug: string;
  name: string;
  description?: string | undefined;
  ownerId: string;
}

/** Postgres unique-violation code, surfaced as a result rather than an error. */
const UNIQUE_VIOLATION = 'P2002';

export type CreateProjectResult =
  { ok: true; project: ProjectRecord } | { ok: false; conflict: 'slug' };

export class ProjectRepository {
  constructor(private readonly db: Database) {}

  /**
   * Creates a project together with its owner's membership.
   *
   * One transaction, because a project with no owner membership would be
   * unreachable by everyone including the person who made it. Access checks
   * read only memberships, so the membership is not a convenience: it is the
   * thing that makes the project usable.
   */
  async create(input: CreateProjectInput): Promise<CreateProjectResult> {
    try {
      const project = await this.db.$transaction(async (tx) => {
        const created = await tx.project.create({
          data: {
            slug: input.slug,
            name: input.name,
            description: input.description ?? null,
            ownerId: input.ownerId,
          },
        });

        await tx.projectMember.create({
          data: { projectId: created.id, userId: input.ownerId, role: 'OWNER' },
        });

        return created;
      });

      return { ok: true, project };
    } catch (error) {
      // A slug collision is an expected outcome of two concurrent requests,
      // not a failure. Anything else is a real error and propagates.
      if (isUniqueViolation(error)) return { ok: false, conflict: 'slug' };
      throw error;
    }
  }

  /**
   * Sets how a project starts, or clears it back to the suggestion.
   *
   * On the project rather than on a runtime, because it outlives every
   * container: telling the platform once should be enough.
   */
  /** Changes what a project is called and what it says about itself. */
  update(
    projectId: string,
    input: { name?: string | undefined; description?: string | null | undefined },
  ): Promise<ProjectRecord> {
    return this.db.project.update({
      where: { id: projectId },
      data: {
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.description === undefined ? {} : { description: input.description }),
      },
    });
  }

  async setRunCommand(projectId: string, command: string | null): Promise<void> {
    await this.db.project.update({ where: { id: projectId }, data: { runCommand: command } });
  }

  findById(id: string): Promise<ProjectRecord | null> {
    return this.db.project.findUnique({ where: { id } });
  }

  /**
   * Loads a project and the caller's access to it in one query.
   *
   * The membership is absent when the caller has none, which the service
   * treats identically to the project not existing.
   */
  async findWithMembership(
    projectId: string,
    userId: string,
  ): Promise<{ project: ProjectRecord; membership: MembershipRecord | null } | null> {
    const project = await this.db.project.findUnique({
      where: { id: projectId },
      include: { members: { where: { userId }, take: 1 } },
    });

    if (!project) return null;

    const { members, ...record } = project;
    return { project: record, membership: members[0] ?? null };
  }

  findMembership(projectId: string, userId: string): Promise<MembershipRecord | null> {
    return this.db.projectMember.findUnique({
      where: { projectId_userId: { projectId, userId } },
    });
  }

  listMembers(projectId: string): Promise<MemberWithUser[]> {
    return this.db.projectMember.findMany({
      where: { projectId },
      include: { user: { select: { id: true, username: true, displayName: true } } },
      // Owners first, then by when they joined, so the list reads sensibly.
      orderBy: [{ role: 'desc' }, { createdAt: 'asc' }],
    });
  }

  /** Every project the user can reach, at any access level. */
  listForUser(userId: string): Promise<(ProjectRecord & { members: MembershipRecord[] })[]> {
    return this.db.project.findMany({
      where: { members: { some: { userId } } },
      include: { members: { where: { userId }, take: 1 } },
      orderBy: { createdAt: 'desc' },
    });
  }

  upsertMembership(
    projectId: string,
    userId: string,
    role: ProjectRole,
  ): Promise<MembershipRecord> {
    return this.db.projectMember.upsert({
      where: { projectId_userId: { projectId, userId } },
      create: { projectId, userId, role },
      update: { role },
    });
  }

  async removeMembership(projectId: string, userId: string): Promise<void> {
    await this.db.projectMember.deleteMany({ where: { projectId, userId } });
  }

  countOwners(projectId: string): Promise<number> {
    return this.db.projectMember.count({ where: { projectId, role: 'OWNER' } });
  }

  /**
   * The projects one account owns, identifiers only.
   *
   * Ownership rather than membership, because they are deleted differently: a
   * project you own goes when your account does, and a project you were merely
   * invited to carries on without you.
   */
  async listOwnedIds(ownerId: string): Promise<string[]> {
    const rows = await this.db.project.findMany({ where: { ownerId }, select: { id: true } });
    return rows.map((row) => row.id);
  }

  countForOwner(ownerId: string): Promise<number> {
    return this.db.project.count({ where: { ownerId } });
  }

  async slugExists(ownerId: string, slug: string): Promise<boolean> {
    const found = await this.db.project.findUnique({
      where: { ownerId_slug: { ownerId, slug } },
      select: { id: true },
    });
    return found !== null;
  }

  /** Deleting is idempotent: removing an already-removed project is not an error. */
  async delete(projectId: string): Promise<void> {
    await this.db.project.deleteMany({ where: { id: projectId } });
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === UNIQUE_VIOLATION
  );
}
