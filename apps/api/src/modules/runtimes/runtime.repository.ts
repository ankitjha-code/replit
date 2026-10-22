import type { RunStatus, RuntimeStatus } from '@platform/shared';
import type { Database } from '../../db/client.js';

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
  from: RuntimeStatus;
  expectedRevision: number;
  to: RuntimeStatus;
  message: string | null;
  externalId?: string | null;
  startedAt?: Date | null;
  stoppedAt?: Date | null;
  actorId?: string | null;
  reason?: string | null;
}

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

  async transition(input: TransitionInput): Promise<RuntimeRecord | null> {
    return this.db.$transaction(async (tx) => {
      const moved = await tx.runtime.updateMany({
        where: { id: input.runtimeId, status: input.from, revision: input.expectedRevision },
        data: {
          status: input.to,
          message: input.message,
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

  setPreviewPort(runtimeId: string, previewPort: number | null): Promise<unknown> {
    return this.db.runtime.updateMany({ where: { id: runtimeId }, data: { previewPort } });
  }

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
