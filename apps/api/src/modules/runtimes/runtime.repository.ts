import type { RunStatus, RuntimeStatus } from '@platform/shared';
import type { Database } from '../../db/client.js';

/**
 * The only code that reads or writes the runtimes tables.
 *
 * Which transitions are legal belongs to the service. This layer's one
 * contribution to correctness is that a status change is conditional: it moves
 * a row only if the row is still where the caller last saw it.
 */

export interface RuntimeRecord {
  id: string;
  projectId: string;
  status: RuntimeStatus;
  provider: string;
  externalId: string | null;
  language: string;
  version: string;
  image: string;
  cpuMillicores: number;
  memoryMb: number;
  pidsLimit: number;
  message: string | null;
  /** The application inside the container, which has its own lifecycle. */
  runStatus: RunStatus;
  runCommand: string | null;
  runStartedAt: Date | null;
  runExitedAt: Date | null;
  runExitCode: number | null;
  runMessage: string | null;
  previewPort: number | null;
  revision: number;
  requestedById: string | null;
  statusChangedAt: Date;
  startedAt: Date | null;
  stoppedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateRuntimeInput {
  projectId: string;
  provider: string;
  language: string;
  version: string;
  image: string;
  cpuMillicores: number;
  memoryMb: number;
  pidsLimit: number;
  requestedById: string;
}

export interface TransitionInput {
  runtimeId: string;
  /** The status the caller believes the runtime is in. */
  from: RuntimeStatus;
  /** The revision the caller believes it is at. */
  expectedRevision: number;
  to: RuntimeStatus;
  /** User-safe explanation. Null clears any previous one. */
  message: string | null;
  externalId?: string | null;
  startedAt?: Date | null;
  stoppedAt?: Date | null;
  actorId?: string | null;
  reason?: string | null;
}

/** Postgres unique-violation code, surfaced as a result rather than an error. */
const UNIQUE_VIOLATION = 'P2002';

export type CreateRuntimeResult =
  { ok: true; runtime: RuntimeRecord } | { ok: false; conflict: 'project' };

export class RuntimeRepository {
  constructor(private readonly db: Database) {}

  findByProject(projectId: string): Promise<RuntimeRecord | null> {
    return this.db.runtime.findUnique({ where: { projectId } });
  }

  findById(id: string): Promise<RuntimeRecord | null> {
    return this.db.runtime.findUnique({ where: { id } });
  }

  /**
   * Creates the runtime row for a project.
   *
   * The unique constraint on `projectId` is what actually prevents two
   * concurrent starts from both creating one. A check-then-insert in
   * application code cannot, because both requests can pass the check before
   * either writes.
   *
   * Losing that race is an expected outcome rather than a failure, so it comes
   * back as a result. The loser has not been harmed: the runtime it wanted now
   * exists.
   */
  async create(input: CreateRuntimeInput): Promise<CreateRuntimeResult> {
    try {
      const runtime = await this.db.$transaction(async (tx) => {
        const created = await tx.runtime.create({
          data: {
            projectId: input.projectId,
            provider: input.provider,
            status: 'REQUESTED',
            language: input.language,
            version: input.version,
            image: input.image,
            cpuMillicores: input.cpuMillicores,
            memoryMb: input.memoryMb,
            pidsLimit: input.pidsLimit,
            requestedById: input.requestedById,
          },
        });

        await tx.runtimeEvent.create({
          data: { runtimeId: created.id, toStatus: 'REQUESTED', actorId: input.requestedById },
        });

        return created;
      });

      return { ok: true, runtime };
    } catch (error) {
      if (isUniqueViolation(error)) return { ok: false, conflict: 'project' };
      throw error;
    }
  }

  /**
   * Moves a runtime to a new status, if it has not moved since it was read.
   *
   * Returns null when the row was not where the caller expected. That is not
   * an error in itself: it means something else changed the runtime first, and
   * the caller has to decide what to do about it rather than overwrite the
   * result.
   *
   * The event row is written in the same transaction as the change, so the
   * history can never disagree with the state it describes.
   */
  async transition(input: TransitionInput): Promise<RuntimeRecord | null> {
    return this.db.$transaction(async (tx) => {
      const moved = await tx.runtime.updateMany({
        where: { id: input.runtimeId, status: input.from, revision: input.expectedRevision },
        data: {
          status: input.to,
          message: input.message,
          // What was listening before says nothing about what will be
          // listening next time, and a stale port sends the proxy nowhere.
          ...(input.to === 'RUNNING' ? {} : { previewPort: null }),
          revision: { increment: 1 },
          statusChangedAt: new Date(),
          ...(input.externalId === undefined ? {} : { externalId: input.externalId }),
          ...(input.startedAt === undefined ? {} : { startedAt: input.startedAt }),
          ...(input.stoppedAt === undefined ? {} : { stoppedAt: input.stoppedAt }),
          ...(input.actorId === undefined ? {} : { requestedById: input.actorId }),
        },
      });

      if (moved.count === 0) return null;

      await tx.runtimeEvent.create({
        data: {
          runtimeId: input.runtimeId,
          fromStatus: input.from,
          toStatus: input.to,
          reason: input.reason ?? input.message,
          actorId: input.actorId ?? null,
        },
      });

      return tx.runtime.findUnique({ where: { id: input.runtimeId } });
    });
  }

  /**
   * Records the provider's identifier for the workload.
   *
   * Written as soon as the workload exists rather than at the next transition,
   * so a failure in between leaves something to clean up by. A container the
   * database cannot name is a container nobody will ever remove.
   */
  attachExternalId(
    runtimeId: string,
    externalId: string,
    executionHost: string | null,
  ): Promise<RuntimeRecord> {
    return this.db.runtime.update({
      where: { id: runtimeId },
      data: { externalId, executionHost },
    });
  }

  /**
   * Records the port an application was found on.
   *
   * A cache, not a decision: it saves the next request a round of probing and
   * is checked again before it is used.
   */
  setPreviewPort(runtimeId: string, previewPort: number | null): Promise<unknown> {
    return this.db.runtime.updateMany({ where: { id: runtimeId }, data: { previewPort } });
  }

  /**
   * Records what the application inside a runtime is doing.
   *
   * Separate from the runtime's own transitions, and deliberately not
   * conditional: the application's state is observed rather than negotiated,
   * so there is no race for two writers to lose.
   */
  setRunState(
    runtimeId: string,
    state: {
      runStatus: RunStatus;
      runCommand?: string | null;
      runStartedAt?: Date | null;
      runExitedAt?: Date | null;
      runExitCode?: number | null;
      runMessage?: string | null;
      previewPort?: number | null;
    },
  ): Promise<RuntimeRecord> {
    return this.db.runtime.update({ where: { id: runtimeId }, data: state });
  }

  /**
   * Replaces the identity of an existing runtime before it is started again.
   *
   * A project whose files changed from Python to Node must not be restarted on
   * the image it used last time.
   */
  updateSpec(
    runtimeId: string,
    spec: {
      provider: string;
      language: string;
      version: string;
      image: string;
      cpuMillicores: number;
      memoryMb: number;
      pidsLimit: number;
    },
  ): Promise<RuntimeRecord> {
    return this.db.runtime.update({ where: { id: runtimeId }, data: spec });
  }

  listEvents(runtimeId: string, limit = 50) {
    return this.db.runtimeEvent.findMany({
      where: { runtimeId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  /** Runtimes the execution plane may still be holding, for reconciliation. */
  listByStatus(statuses: readonly RuntimeStatus[]): Promise<RuntimeRecord[]> {
    return this.db.runtime.findMany({ where: { status: { in: [...statuses] } } });
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === UNIQUE_VIOLATION
  );
}
