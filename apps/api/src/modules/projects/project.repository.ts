import type { ProjectRole } from '@platform/shared';
import type { Database } from '../../db/client.js';

export interface ProjectRecord {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  ownerId: string;
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

const UNIQUE_VIOLATION = 'P2002';

export type CreateProjectResult =
  { ok: true; project: ProjectRecord } | { ok: false; conflict: 'slug' };

export class ProjectRepository {
  constructor(private readonly db: Database) {}

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
      if (isUniqueViolation(error)) return { ok: false, conflict: 'slug' };
      throw error;
    }
  }

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
      orderBy: [{ role: 'desc' }, { createdAt: 'asc' }],
    });
  }

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
