import {
  PROJECT_SLUG_MAX_LENGTH,
  slugify,
  type CreateProjectRequest,
  type ProjectRole,
  type ProjectSummary,
} from '@platform/shared';
import type { Logger } from 'pino';
import { AppError } from '../../errors/app-error.js';
import type { ProjectRecord, ProjectRepository } from './project.repository.js';

export interface ProjectServiceOptions {
  maxProjectsPerUser: number;
}

const MAX_SLUG_ATTEMPTS = 25;

export class ProjectService {
  constructor(
    private readonly projects: ProjectRepository,
    private readonly options: ProjectServiceOptions,
    private readonly log: Logger,
  ) {}

  async create(ownerId: string, input: CreateProjectRequest): Promise<ProjectSummary> {
    const existing = await this.projects.countForOwner(ownerId);
    if (existing >= this.options.maxProjectsPerUser) {
      throw new AppError(
        'CONFLICT',
        `You have reached the limit of ${this.options.maxProjectsPerUser} projects`,
        { details: { limit: this.options.maxProjectsPerUser } },
      );
    }

    const slug = await this.resolveSlug(ownerId, input);
    const project = await this.createWithSlug(ownerId, slug, input);

    this.log.info({ projectId: project.id, ownerId }, 'project created');
    return toSummary(project, 'OWNER');
  }

  async listForUser(userId: string): Promise<ProjectSummary[]> {
    const rows = await this.projects.listForUser(userId);
    return rows.map((row) => {
      const role = row.members[0]?.role;
      if (!role) {
        throw new Error(`project ${row.id} was listed for ${userId} with no membership`);
      }
      return toSummary(row, role);
    });
  }

  async update(
    projectId: string,
    input: { name?: string | undefined; description?: string | null | undefined },
  ): Promise<ProjectRecord> {
    const record = await this.projects.update(projectId, input);
    this.log.info({ projectId }, 'project renamed');
    return record;
  }

  async delete(projectId: string): Promise<void> {
    await this.deployments?.releaseProject(projectId);
    await this.runtimes?.releaseProject(projectId);
    await this.databases?.release(projectId);
    await this.databaseBackups?.releaseProject(projectId);
    await this.snapshots?.releaseProject(projectId);
    await this.git?.releaseProject(projectId);

    await this.projects.delete(projectId);
    this.log.info({ projectId }, 'project deleted');
  }

  private databases: { release(projectId: string): Promise<void> } | undefined;

  useDatabases(databases: { release(projectId: string): Promise<void> }): void {
    this.databases = databases;
  }

  private databaseBackups?: { releaseProject(projectId: string): Promise<void> };

  useDatabaseBackups(backups: NonNullable<typeof this.databaseBackups>): void {
    this.databaseBackups = backups;
  }

  private runtimes?: { releaseProject(projectId: string): Promise<void> };

  useRuntimes(runtimes: NonNullable<typeof this.runtimes>): void {
    this.runtimes = runtimes;
  }

  private snapshots: { releaseProject(projectId: string): Promise<void> } | undefined;

  useSnapshots(snapshots: { releaseProject(projectId: string): Promise<void> }): void {
    this.snapshots = snapshots;
  }

  private deployments: { releaseProject(projectId: string): Promise<void> } | undefined;

  useDeployments(deployments: { releaseProject(projectId: string): Promise<void> }): void {
    this.deployments = deployments;
  }

  private git: { releaseProject(projectId: string): Promise<void> } | undefined;

  useGit(git: { releaseProject(projectId: string): Promise<void> }): void {
    this.git = git;
  }

  private async resolveSlug(ownerId: string, input: CreateProjectRequest): Promise<string> {
    if (input.slug) {
      if (await this.projects.slugExists(ownerId, input.slug)) {
        throw new AppError('CONFLICT', 'You already have a project with that slug', {
          details: { field: 'slug' },
        });
      }
      return input.slug;
    }

    const base = slugify(input.name);
    if (!base) {
      throw new AppError(
        'VALIDATION_FAILED',
        'A slug could not be derived from that name. Please provide one.',
        { details: { fields: [{ path: 'slug', message: 'Enter a slug for the URL' }] } },
      );
    }

    return this.findAvailableSlug(ownerId, base);
  }

  private async findAvailableSlug(ownerId: string, base: string): Promise<string> {
    if (!(await this.projects.slugExists(ownerId, base))) return base;

    for (let suffix = 2; suffix <= MAX_SLUG_ATTEMPTS; suffix += 1) {
      const candidate = withSuffix(base, String(suffix));
      if (!(await this.projects.slugExists(ownerId, candidate))) return candidate;
    }

    return withSuffix(base, Math.random().toString(36).slice(2, 8));
  }

  private async createWithSlug(
    ownerId: string,
    slug: string,
    input: CreateProjectRequest,
    isRetry = false,
  ): Promise<ProjectRecord> {
    const result = await this.projects.create({
      slug,
      name: input.name,
      description: input.description,
      ownerId,
    });

    if (result.ok) return result.project;

    if (input.slug || isRetry) {
      throw new AppError('CONFLICT', 'You already have a project with that slug', {
        details: { field: 'slug' },
      });
    }

    const retrySlug = withSuffix(slugify(input.name), Math.random().toString(36).slice(2, 8));
    return this.createWithSlug(ownerId, retrySlug, input, true);
  }
}

function withSuffix(base: string, suffix: string): string {
  const room = PROJECT_SLUG_MAX_LENGTH - suffix.length - 1;
  return `${base.slice(0, room).replace(/-+$/, '')}-${suffix}`;
}

export function toSummary(project: ProjectRecord, role: ProjectRole): ProjectSummary {
  return {
    id: project.id,
    slug: project.slug,
    name: project.name,
    description: project.description,
    role,
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
  };
}
