import { pino } from 'pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppError } from '../../errors/app-error.js';
import { ProjectService } from './project.service.js';
import type {
  CreateProjectInput,
  CreateProjectResult,
  ProjectRecord,
  ProjectRepository,
} from './project.repository.js';

const silent = pino({ level: 'silent' });

/**
 * In-memory projects table.
 *
 * Slug derivation and the account limit are decisions the service makes, and
 * none of them need a database. The unique constraint they cooperate with is
 * exercised against a real one in the integration suite.
 */
class FakeProjectRepository {
  rows: ProjectRecord[] = [];
  private nextId = 1;
  /** Forces the next write to collide, simulating a concurrent creation. */
  collideOnce = false;

  create = vi.fn(async (input: CreateProjectInput): Promise<CreateProjectResult> => {
    if (this.collideOnce) {
      this.collideOnce = false;
      return { ok: false, conflict: 'slug' };
    }
    if (this.rows.some((r) => r.ownerId === input.ownerId && r.slug === input.slug)) {
      return { ok: false, conflict: 'slug' };
    }

    const project: ProjectRecord = {
      id: `project-${this.nextId++}`,
      slug: input.slug,
      name: input.name,
      description: input.description ?? null,
      ownerId: input.ownerId,
      runCommand: null,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
    };
    this.rows.push(project);
    return { ok: true, project };
  });

  slugExists = vi.fn(async (ownerId: string, slug: string) =>
    this.rows.some((r) => r.ownerId === ownerId && r.slug === slug),
  );

  countForOwner = vi.fn(
    async (ownerId: string) => this.rows.filter((r) => r.ownerId === ownerId).length,
  );

  listForUser = vi.fn(async (userId: string) =>
    this.rows
      .filter((r) => r.ownerId === userId)
      .map((r) => ({
        ...r,
        members: [
          {
            id: 'm',
            projectId: r.id,
            userId,
            role: 'OWNER' as const,
            createdAt: r.createdAt,
            updatedAt: r.updatedAt,
          },
        ],
      })),
  );

  delete = vi.fn(async (projectId: string) => {
    this.rows = this.rows.filter((r) => r.id !== projectId);
  });
}

let repository: FakeProjectRepository;
let service: ProjectService;

const build = (maxProjectsPerUser = 50): ProjectService =>
  new ProjectService(repository as unknown as ProjectRepository, { maxProjectsPerUser }, silent);

beforeEach(() => {
  repository = new FakeProjectRepository();
  service = build();
});

describe('creating a project', () => {
  it('derives a slug from the name', async () => {
    const project = await service.create('ada', { name: 'My First Project' });
    expect(project.slug).toBe('my-first-project');
  });

  it('returns the caller as the owner', async () => {
    const project = await service.create('ada', { name: 'Engine' });
    expect(project.role).toBe('OWNER');
  });

  it('keeps an explicit slug rather than deriving one', async () => {
    const project = await service.create('ada', { name: 'My First Project', slug: 'engine' });
    expect(project.slug).toBe('engine');
  });

  it('stores the description when given, and null when not', async () => {
    expect((await service.create('ada', { name: 'A', description: 'Notes' })).description).toBe(
      'Notes',
    );
    expect((await service.create('ada', { name: 'B' })).description).toBeNull();
  });

  it('never lets the caller choose the owner', async () => {
    // The owner comes from the session, not the body.
    await service.create('ada', { name: 'Engine' } as never);
    expect(repository.rows[0]?.ownerId).toBe('ada');
  });
});

describe('slug collisions', () => {
  it('numbers a derived slug that is already taken', async () => {
    await service.create('ada', { name: 'My Project' });
    const second = await service.create('ada', { name: 'My Project' });
    expect(second.slug).toBe('my-project-2');
  });

  it('keeps counting past the second collision', async () => {
    for (let i = 0; i < 3; i += 1) await service.create('ada', { name: 'My Project' });
    expect(repository.rows.map((r) => r.slug)).toEqual([
      'my-project',
      'my-project-2',
      'my-project-3',
    ]);
  });

  it('does not renumber across owners', async () => {
    // Slugs are scoped per account, so two people may both have "my-project".
    await service.create('ada', { name: 'My Project' });
    const grace = await service.create('grace', { name: 'My Project' });
    expect(grace.slug).toBe('my-project');
  });

  it('refuses an explicit slug that is taken, naming the field', async () => {
    await service.create('ada', { name: 'A', slug: 'engine' });

    const error = (await service
      .create('ada', { name: 'B', slug: 'engine' })
      .catch((e: unknown) => e)) as AppError;

    // The user chose it, so it is theirs to resolve rather than something to
    // silently renumber.
    expect(error.code).toBe('CONFLICT');
    expect(error.details).toEqual({ field: 'slug' });
  });

  it('recovers when it loses a race to a concurrent creation', async () => {
    // The existence check passed, but the unique constraint decided otherwise.
    repository.collideOnce = true;

    const project = await service.create('ada', { name: 'My Project' });
    expect(project.slug).toMatch(/^my-project-[a-z0-9]{1,6}$/);
  });

  it('gives up rather than looping when a retry also collides', async () => {
    repository.create.mockResolvedValue({ ok: false, conflict: 'slug' });

    const error = (await service
      .create('ada', { name: 'My Project' })
      .catch((e: unknown) => e)) as AppError;

    expect(error.code).toBe('CONFLICT');
  });

  it('keeps a suffixed slug inside the column width', async () => {
    const long = 'a'.repeat(70);
    await service.create('ada', { name: long });
    const second = await service.create('ada', { name: long });

    expect(second.slug.length).toBeLessThanOrEqual(63);
    expect(second.slug.endsWith('-2')).toBe(true);
  });
});

describe('names with no usable slug', () => {
  it('asks for a slug rather than inventing one', async () => {
    const error = (await service
      .create('ada', { name: '日本語' })
      .catch((e: unknown) => e)) as AppError;

    expect(error.code).toBe('VALIDATION_FAILED');
    expect(JSON.stringify(error.details)).toContain('slug');
  });

  it('accepts such a name when a slug is supplied', async () => {
    const project = await service.create('ada', { name: '日本語', slug: 'nihongo' });
    expect(project.slug).toBe('nihongo');
    expect(project.name).toBe('日本語');
  });
});

describe('the per-account limit', () => {
  it('refuses once the ceiling is reached', async () => {
    service = build(2);
    await service.create('ada', { name: 'One' });
    await service.create('ada', { name: 'Two' });

    const error = (await service
      .create('ada', { name: 'Three' })
      .catch((e: unknown) => e)) as AppError;
    expect(error.code).toBe('CONFLICT');
    expect(error.details).toEqual({ limit: 2 });
  });

  it('counts per account, not globally', async () => {
    service = build(1);
    await service.create('ada', { name: 'Mine' });
    await expect(service.create('grace', { name: 'Theirs' })).resolves.toBeDefined();
  });

  it('checks before doing any work', async () => {
    service = build(1);
    await service.create('ada', { name: 'One' });
    repository.create.mockClear();

    await service.create('ada', { name: 'Two' }).catch(() => undefined);
    expect(repository.create).not.toHaveBeenCalled();
  });
});

describe('listing and deleting', () => {
  it('returns each project with the caller own role', async () => {
    await service.create('ada', { name: 'One' });
    const listed = await service.listForUser('ada');
    expect(listed[0]?.role).toBe('OWNER');
  });

  it('returns nothing for a user with no projects', async () => {
    await expect(service.listForUser('nobody')).resolves.toEqual([]);
  });

  it('removes a project', async () => {
    const project = await service.create('ada', { name: 'One' });
    await service.delete(project.id);
    expect(repository.rows).toHaveLength(0);
  });

  it('frees the slug and the quota slot', async () => {
    service = build(1);
    const project = await service.create('ada', { name: 'One' });
    await service.delete(project.id);

    const replacement = await service.create('ada', { name: 'One' });
    expect(replacement.slug).toBe('one');
  });
});

describe('what goes first when a project is deleted', () => {
  it('releases deployments before the environment, and both before the row', async () => {
    const order: string[] = [];
    const releaser = (name: string) => ({
      releaseProject: async () => {
        order.push(name);
      },
    });
    service.useDeployments(releaser('deployments'));
    service.useRuntimes(releaser('runtimes'));
    service.useSnapshots(releaser('snapshots'));
    service.useGit(releaser('git'));
    repository.delete.mockImplementationOnce(async () => {
      order.push('row');
    });

    const project = await service.create('ada', { name: 'One' });
    await service.delete(project.id);

    // The environment's release removes the project's network, which cannot go
    // while a deployment is still attached to it.
    expect(order.indexOf('deployments')).toBeLessThan(order.indexOf('runtimes'));
    expect(order.at(-1)).toBe('row');
  });
});
