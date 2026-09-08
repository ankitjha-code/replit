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

/**
 * Project lifecycle.
 *
 * Slug derivation and the per-account limit live here. The repository below
 * stores what it is given; the authorization service beside it decides who may
 * ask.
 */

export interface ProjectServiceOptions {
  /** Ceiling per account. Each project will eventually own a container. */
  maxProjectsPerUser: number;
}

/**
 * How many times to try a numbered variant before giving up on readable slugs.
 *
 * Beyond this the collisions are not accidental, and continuing to count would
 * mean an unbounded number of queries for one request.
 */
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
        // listForUser filters on membership, so this cannot happen without a
        // query change. Failing loudly beats guessing a role.
        throw new Error(`project ${row.id} was listed for ${userId} with no membership`);
      }
      return toSummary(row, role);
    });
  }

  /**
   * Renames a project, or changes its description.
   *
   * Trimmed on the way in by the schema, and the slug left alone: see the
   * schema for why the one thing in every shared URL is not renameable.
   */
  async update(
    projectId: string,
    input: { name?: string | undefined; description?: string | null | undefined },
  ): Promise<ProjectRecord> {
    const record = await this.projects.update(projectId, input);
    this.log.info({ projectId }, 'project renamed');
    return record;
  }

  async delete(projectId: string): Promise<void> {
    /*
     * Anything living outside this database, before the row that points at it.
     *
     * Memberships, files, variables and secrets all cascade. A project's own
     * database does not: it is in another server, and deleting the row that
     * names it would leave it there with nobody able to say what it was for.
     *
     * Deliberately before the delete and deliberately not fatal. A project must
     * stay deletable when that server is unreachable, so a failure is recorded
     * as a leak rather than turning into a project nobody can remove.
     */
    // Deployments first, then the environment. Releasing the environment removes
    // the project's network, and a network cannot go while anything — the
    // environment's container or a deployment's — is still attached to it.
    // (Found running the production stack: deleting a project with a live
    // deployment left its network behind for the sweep.)
    await this.deployments?.releaseProject(projectId);
    await this.runtimes?.releaseProject(projectId);
    await this.databases?.release(projectId);
    await this.databaseBackups?.releaseProject(projectId);
    await this.snapshots?.releaseProject(projectId);
    await this.git?.releaseProject(projectId);

    // Deployments go before snapshots, because a deployment holds the snapshot
    // it was built from and removing that first would leave it describing a
    // version nobody can read.
    await this.projects.delete(projectId);
    this.log.info({ projectId }, 'project deleted');
  }

  /**
   * Told how to remove a project's own database.
   *
   * Set after construction rather than taken as a constructor argument: the
   * database service needs nothing from this one, but wiring it in the other
   * direction would make project creation depend on a database server being
   * configured, which it must not.
   */
  private databases: { release(projectId: string): Promise<void> } | undefined;

  useDatabases(databases: { release(projectId: string): Promise<void> }): void {
    this.databases = databases;
  }

  /**
   * Told how to remove the copies of that database.
   *
   * A separate collaborator from the database itself, because they live in
   * different places: the database is in another server and its backups are in
   * object storage. Deleting one has never implied deleting the other.
   */
  private databaseBackups?: { releaseProject(projectId: string): Promise<void> };

  useDatabaseBackups(backups: NonNullable<typeof this.databaseBackups>): void {
    this.databaseBackups = backups;
  }

  /**
   * Told how to remove a project's environment: its container, its shells and
   * its network. All three live with the container runtime, which no cascade
   * reaches.
   */
  private runtimes?: { releaseProject(projectId: string): Promise<void> };

  useRuntimes(runtimes: NonNullable<typeof this.runtimes>): void {
    this.runtimes = runtimes;
  }

  /**
   * Told how to remove a project's snapshots.
   *
   * They are archives in object storage, which no database cascade reaches, so
   * deleting the rows alone would leave the bytes behind for ever.
   */
  private snapshots: { releaseProject(projectId: string): Promise<void> } | undefined;

  useSnapshots(snapshots: { releaseProject(projectId: string): Promise<void> }): void {
    this.snapshots = snapshots;
  }

  /** Told how to remove a project's history, which is an archive of its own. */
  /**
   * Anything this project has deployed, told when the project is going.
   *
   * A deployment is held by a provider outside this database, so no cascade
   * reaches it: the row would go and whatever is serving would stay up.
   */
  private deployments: { releaseProject(projectId: string): Promise<void> } | undefined;

  useDeployments(deployments: { releaseProject(projectId: string): Promise<void> }): void {
    this.deployments = deployments;
  }

  private git: { releaseProject(projectId: string): Promise<void> } | undefined;

  useGit(git: { releaseProject(projectId: string): Promise<void> }): void {
    this.git = git;
  }

  /**
   * Chooses a slug: the one asked for, or one derived from the name.
   *
   * An explicit slug that is taken is an error the user can act on. A derived
   * one that is taken is not their problem, so it gets a number appended.
   */
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
      // Nothing usable survived, which happens for a name written entirely in
      // a non-Latin script. Asking is better than inventing something opaque.
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

    // Readable variants are exhausted. A random tail always terminates, which
    // matters more here than the slug being pretty.
    return withSuffix(base, Math.random().toString(36).slice(2, 8));
  }

  /**
   * Writes the project, retrying once on a slug collision.
   *
   * The existence check above is advisory: two requests can both pass it. The
   * unique constraint is what actually decides, and losing that race is a
   * normal outcome rather than an error to show the user.
   */
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
      // Either the user chose this slug, so the conflict is theirs to resolve,
      // or one retry already failed and looping further would not help.
      throw new AppError('CONFLICT', 'You already have a project with that slug', {
        details: { field: 'slug' },
      });
    }

    const retrySlug = withSuffix(slugify(input.name), Math.random().toString(36).slice(2, 8));
    return this.createWithSlug(ownerId, retrySlug, input, true);
  }
}

/** Appends a suffix, trimming the base so the result still fits the column. */
function withSuffix(base: string, suffix: string): string {
  const room = PROJECT_SLUG_MAX_LENGTH - suffix.length - 1;
  return `${base.slice(0, room).replace(/-+$/, '')}-${suffix}`;
}

/**
 * The only shape of a project that leaves the server.
 *
 * Built explicitly rather than by spreading the row, so a column added later
 * cannot leak by default.
 */
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
