import {
  DEFAULT_RESOURCE_LIMITS,
  RUNTIME_DEFINITIONS,
  RUNTIME_TRANSITIONS,
  canTransition,
  detectRuntime,
  isRuntimeLanguage,
  type ResourceLimits,
  type RuntimeDetection,
  type RuntimeLanguage,
  type RuntimeStateResponse,
  type RuntimeStatus,
  type RuntimeSummary,
  type TerminalSize,
  type WorkspaceSyncResult,
} from '@platform/shared';
import type { Logger } from 'pino';
import { AppError } from '../../errors/app-error.js';
import type { ProjectEventPublisher } from '../../events/project-event-bus.js';
import type { ExecutionProvider, TerminalSession } from '../../execution/provider.js';
import type { FileService } from '../files/file.service.js';
import type { RuntimeRecord, RuntimeRepository } from './runtime.repository.js';

export interface SecretProvider {
  forRuntime(projectId: string): Promise<Record<string, string>>;
}

export interface VariableProvider {
  forRuntime(projectId: string): Promise<Record<string, string>>;
}

export interface DatabaseEnvProvider {
  forRuntime(projectId: string): Promise<Record<string, string>>;
}

export interface RuntimeServiceOptions {
  limits: ResourceLimits;
  stopGraceSeconds: number;
}

export const DEFAULT_RUNTIME_OPTIONS: RuntimeServiceOptions = {
  limits: DEFAULT_RESOURCE_LIMITS,
  stopGraceSeconds: 10,
};

export class RuntimeService {
  constructor(
    private readonly runtimes: RuntimeRepository,
    private readonly files: FileService,
    private readonly secrets: SecretProvider,
    private readonly variables: VariableProvider,
    private readonly databases: DatabaseEnvProvider,
    private readonly provider: ExecutionProvider,
    private readonly options: RuntimeServiceOptions,
    private readonly log: Logger,
  ) {}

  async describe(projectId: string): Promise<RuntimeStateResponse> {
    const [record, detected, reason] = await Promise.all([
      this.runtimes.findByProject(projectId),
      this.detect(projectId),
      this.provider.unavailableReason(),
    ]);

    return {
      runtime: record ? toSummary(record) : null,
      detected,
      provider: { name: this.provider.name, available: reason === null, reason },
    };
  }

  async detect(projectId: string): Promise<RuntimeDetection | null> {
    const tree = await this.files.listTree(projectId);
    const paths = tree.entries.filter((entry) => entry.type === 'FILE').map((entry) => entry.path);
    return detectRuntime(paths);
  }

  async start(
    projectId: string,
    actorId: string,
    override?: RuntimeLanguage,
  ): Promise<RuntimeStateResponse> {
    await this.requireProvider();

    const existing = await this.runtimes.findByProject(projectId);

    if (existing && (existing.status === 'RUNNING' || isInFlight(existing.status))) {
      return this.describe(projectId);
    }

    await this.quotas?.require(projectId, 'RUNTIMES');

    const spec = await this.resolveSpec(projectId, override);

    let runtime: RuntimeRecord;
    if (existing) {
      runtime = await this.reuse(existing, spec, actorId);
    } else {
      const created = await this.runtimes.create({
        projectId,
        provider: this.provider.name,
        language: spec.language,
        version: spec.version,
        image: spec.image,
        cpuMillicores: this.options.limits.cpuMillicores,
        memoryMb: this.options.limits.memoryMb,
        pidsLimit: this.options.limits.pidsLimit,
        requestedById: actorId,
      });

      if (!created.ok) return this.describe(projectId);
      runtime = created.runtime;
    }

    if (this.queue) {
      await this.queue.enqueue('RUNTIME_START', { runtimeId: runtime.id, actorId }, { projectId });
    } else {
      await this.provision(runtime, actorId);
    }

    return this.describe(projectId);
  }

  async provisionRequested(runtimeId: string, actorId: string): Promise<void> {
    const runtime = await this.runtimes.findById(runtimeId);

    if (!runtime) {
      this.log.info({ runtimeId }, 'a queued runtime start had nothing to start');
      return;
    }

    if (runtime.status !== 'REQUESTED') {
      this.log.info(
        { runtimeId, status: runtime.status },
        'a queued runtime start found the runtime already moved on',
      );
      return;
    }

    await this.provision(runtime, actorId);
  }

  async abandonRequested(runtimeId: string, reason: string): Promise<void> {
    const record = await this.runtimes.findById(runtimeId);
    if (!record || record.status !== 'REQUESTED') return;

    await this.move(record, 'FAILED', {
      actorId: record.requestedById,
      message: reason,
      reason: 'Abandoned',
      stoppedAt: new Date(),
    });

    this.log.warn({ runtimeId, projectId: record.projectId }, 'a requested runtime was abandoned');
  }

  async releaseProject(projectId: string): Promise<void> {
    const existing = await this.runtimes.findByProject(projectId).catch(() => null);

    if (existing) {
      await this.runs?.releaseRuntime(existing.id).catch(() => undefined);
      await this.terminals?.releaseRuntime(existing.id).catch(() => undefined);

      if (existing.externalId) {
        await this.provider.destroy({ externalId: existing.externalId }).catch((error: unknown) => {
          this.log.error(
            { err: error, projectId, runtimeId: existing.id },
            "a deleted project's container could not be removed; the cleanup sweep will find it",
          );
        });
      }
    }

    try {
      for (const network of await this.provider.listNetworks()) {
        if (network.projectId !== projectId) continue;
        await this.provider.removeNetwork(network.id);
      }
    } catch (error) {
      this.log.error(
        { err: error, projectId },
        "a deleted project's network could not be removed; the cleanup sweep will find it",
      );
    }
  }

  async stop(projectId: string, actorId: string, reason?: string): Promise<RuntimeStateResponse> {
    const existing = await this.runtimes.findByProject(projectId);

    if (!existing || existing.status === 'STOPPED' || existing.status === 'FAILED') {
      return this.describe(projectId);
    }

    if (existing.status !== 'RUNNING') {
      throw new AppError(
        'CONFLICT',
        'This runtime is still changing state. Wait for it to settle, then try again.',
      );
    }

    if (!existing.externalId) {
      await this.move(existing, 'STOPPING', { actorId, message: null });
      const stopping = await this.reload(existing.id);
      await this.move(stopping, 'STOPPED', {
        actorId,
        message: null,
        stoppedAt: new Date(),
        reason: 'No workload had been created',
      });
      return this.describe(projectId);
    }

    await this.requireProvider();

    await this.runs?.releaseRuntime(existing.id);

    await this.terminals?.releaseRuntime(existing.id);

    try {
      const result = await this.files.applyFromRuntime(
        projectId,
        await this.provider.readWorkspace({ externalId: existing.externalId }),
      );
      this.log.info({ projectId, ...summarise(result) }, 'workspace read back before stopping');
    } catch (error) {
      this.log.error(
        { err: error, projectId },
        'could not read the workspace back before stopping',
      );
    }

    const stopping = await this.move(existing, 'STOPPING', { actorId, message: null });

    try {
      await this.provider.stop({ externalId: existing.externalId }, this.options.stopGraceSeconds);
    } catch (error) {
      await this.fail(stopping, error, actorId, 'The runtime could not be stopped.');
      throw this.userFacing(error, 'The runtime could not be stopped.');
    }

    await this.move(stopping, 'STOPPED', {
      actorId,
      message: reason ?? null,
      stoppedAt: new Date(),
    });
    return this.describe(projectId);
  }

  async enforceDiskLimit(limitBytes: number): Promise<{ checked: number; stopped: number }> {
    let checked = 0;
    let stopped = 0;
    for (const runtime of await this.runtimes.listByStatus(['RUNNING'])) {
      if (!runtime.externalId) continue;
      const used = await this.provider.diskUsage({ externalId: runtime.externalId });
      checked += 1;
      if (used === null || used <= limitBytes) continue;

      const message = `Stopped: this environment wrote ${megabytes(used)} to disk, over its ${megabytes(limitBytes)} limit. Remove large files or build output before starting it again.`;
      this.log.warn(
        { projectId: runtime.projectId, runtimeId: runtime.id, used, limitBytes },
        'an environment went over its disk limit and was stopped',
      );
      try {
        await this.stop(runtime.projectId, runtime.requestedById ?? '', message);
        stopped += 1;
      } catch (error) {
        this.log.error(
          { err: error, runtimeId: runtime.id },
          'an environment over its disk limit could not be stopped',
        );
      }
    }
    return { checked, stopped };
  }

  private runs: { releaseRuntime(runtimeId: string): Promise<void> } | undefined;

  useRunService(runs: { releaseRuntime(runtimeId: string): Promise<void> }): void {
    this.runs = runs;
  }

  private terminals: { releaseRuntime(runtimeId: string): Promise<void> } | undefined;

  useTerminalSessions(terminals: { releaseRuntime(runtimeId: string): Promise<void> }): void {
    this.terminals = terminals;
  }

  private events: ProjectEventPublisher | undefined;

  useEvents(events: ProjectEventPublisher): void {
    this.events = events;
  }

  private queue:
    | {
        enqueue(
          type: 'RUNTIME_START',
          payload: unknown,
          options: { projectId: string },
        ): Promise<unknown>;
      }
    | undefined;

  useJobQueue(queue: NonNullable<typeof this.queue>): void {
    this.queue = queue;
  }

  private quotas: { require(projectId: string, kind: 'RUNTIMES'): Promise<void> } | undefined;

  useQuotas(quotas: NonNullable<typeof this.quotas>): void {
    this.quotas = quotas;
  }

  async syncWorkspace(projectId: string): Promise<WorkspaceSyncResult> {
    const record = await this.runtimes.findByProject(projectId);

    if (!record || record.status !== 'RUNNING' || !record.externalId) {
      throw new AppError('PRECONDITION_FAILED', 'Start the project before reading its files back.');
    }

    await this.requireProvider();

    const files = await this.provider.readWorkspace({ externalId: record.externalId });
    return this.files.applyFromRuntime(projectId, files);
  }

  async openTerminal(
    projectId: string,
    size: TerminalSize,
  ): Promise<{ runtimeId: string; session: TerminalSession }> {
    const record = await this.runtimes.findByProject(projectId);

    if (!record || record.status !== 'RUNNING' || !record.externalId) {
      throw new AppError('PRECONDITION_FAILED', 'Start the project before opening a terminal.');
    }

    await this.requireProvider();

    const session = await this.provider.openTerminal({ externalId: record.externalId }, { size });
    return { runtimeId: record.id, session };
  }

  async startDurableTerminal(
    projectId: string,
    terminalId: string,
    size: TerminalSize,
  ): Promise<{ runtimeId: string }> {
    const record = await this.requireRunning(projectId);
    await this.provider.startTerminal({ externalId: record.externalId }, terminalId, { size });
    return { runtimeId: record.id };
  }

  async attachDurableTerminal(projectId: string, terminalId: string): Promise<TerminalSession> {
    const record = await this.requireRunning(projectId);
    return this.provider.attachTerminal({ externalId: record.externalId }, terminalId);
  }

  async durableTerminalRunning(projectId: string, terminalId: string): Promise<boolean> {
    const record = await this.runtimes.findByProject(projectId);
    if (!record || record.status !== 'RUNNING' || !record.externalId) return false;

    return this.provider
      .terminalRunning({ externalId: record.externalId }, terminalId)
      .catch(() => false);
  }

  async stopDurableTerminal(projectId: string, terminalId: string): Promise<void> {
    const record = await this.runtimes.findByProject(projectId);
    if (!record || record.status !== 'RUNNING' || !record.externalId) return;

    await this.provider
      .stopTerminal({ externalId: record.externalId }, terminalId)
      .catch(() => undefined);
  }

  private async requireRunning(projectId: string) {
    const record = await this.runtimes.findByProject(projectId);

    if (!record || record.status !== 'RUNNING' || !record.externalId) {
      throw new AppError('PRECONDITION_FAILED', 'Start the project before opening a terminal.');
    }

    await this.requireProvider();
    return { ...record, externalId: record.externalId };
  }

  private async environmentFor(projectId: string): Promise<Record<string, string>> {
    const [database, variables, secrets] = await Promise.all([
      this.databases.forRuntime(projectId),
      this.variables.forRuntime(projectId),
      this.secrets.forRuntime(projectId),
    ]);
    return { ...database, ...variables, ...secrets };
  }

  async history(projectId: string) {
    const record = await this.runtimes.findByProject(projectId);
    if (!record) return [];
    return this.runtimes.listEvents(record.id);
  }

  private async provision(runtime: RuntimeRecord, actorId: string): Promise<void> {
    const creating = await this.move(runtime, 'CREATING', { actorId, message: null });

    let externalId: string;
    let executionHost: string | null = null;

    try {
      const handle = await this.provider.create({
        workloadId: creating.id,
        kind: 'runtime',
        projectId: creating.projectId,
        image: creating.image,
        limits: {
          cpuMillicores: creating.cpuMillicores,
          memoryMb: creating.memoryMb,
          pidsLimit: creating.pidsLimit,
        },
        env: await this.environmentFor(creating.projectId),
      });
      externalId = handle.externalId;
      executionHost = handle.host ?? null;
    } catch (error) {
      await this.fail(
        creating,
        error,
        actorId,
        'The development environment could not be created.',
      );
      throw this.userFacing(error, 'The development environment could not be created.');
    }

    await this.runtimes.attachExternalId(creating.id, externalId, executionHost);

    try {
      const entries = await this.files.exportAll(creating.projectId);
      await this.provider.seedWorkspace({ externalId }, entries);
    } catch (error) {
      await this.fail(creating, error, actorId, 'The project files could not be copied in.');
      throw this.userFacing(error, 'The project files could not be copied in.');
    }

    const starting = await this.move(creating, 'STARTING', { actorId, message: null, externalId });

    try {
      await this.provider.start({ externalId });
    } catch (error) {
      await this.fail(
        starting,
        error,
        actorId,
        'The development environment could not be started.',
      );
      throw this.userFacing(error, 'The development environment could not be started.');
    }

    await this.move(starting, 'RUNNING', { actorId, message: null, startedAt: new Date() });
  }

  private async reuse(
    existing: RuntimeRecord,
    spec: RuntimeDetection,
    actorId: string,
  ): Promise<RuntimeRecord> {
    await this.runtimes.updateSpec(existing.id, {
      provider: this.provider.name,
      language: spec.language,
      version: spec.version,
      image: spec.image,
      cpuMillicores: this.options.limits.cpuMillicores,
      memoryMb: this.options.limits.memoryMb,
      pidsLimit: this.options.limits.pidsLimit,
    });

    return this.move(existing, 'REQUESTED', { actorId, message: null, externalId: null });
  }

  private async resolveSpec(
    projectId: string,
    override?: RuntimeLanguage,
  ): Promise<RuntimeDetection> {
    if (override) {
      const definition = RUNTIME_DEFINITIONS[override];
      return {
        language: definition.language,
        version: definition.version,
        image: definition.image,
        evidence: 'chosen explicitly',
      };
    }

    const detected = await this.detect(projectId);
    if (detected) return detected;

    throw new AppError(
      'PRECONDITION_FAILED',
      'This project does not say which runtime it needs. Add a manifest such as package.json or requirements.txt, or choose a language.',
    );
  }

  private async requireProvider(): Promise<void> {
    const reason = await this.provider.unavailableReason();
    if (reason) throw new AppError('RUNTIME_UNAVAILABLE', reason, { expose: true });
  }

  private async move(
    record: RuntimeRecord,
    to: RuntimeStatus,
    options: {
      actorId: string | null;
      message: string | null;
      externalId?: string | null;
      startedAt?: Date;
      stoppedAt?: Date;
      reason?: string;
    },
  ): Promise<RuntimeRecord> {
    if (!canTransition(RUNTIME_TRANSITIONS, record.status, to)) {
      throw new Error(`Illegal runtime transition ${record.status} -> ${to}`);
    }

    const next = await this.runtimes.transition({
      runtimeId: record.id,
      from: record.status,
      expectedRevision: record.revision,
      to,
      message: options.message,
      actorId: options.actorId,
      ...(options.externalId === undefined ? {} : { externalId: options.externalId }),
      ...(options.startedAt === undefined ? {} : { startedAt: options.startedAt }),
      ...(options.stoppedAt === undefined ? {} : { stoppedAt: options.stoppedAt }),
      ...(options.reason === undefined ? {} : { reason: options.reason }),
    });

    if (!next) {
      throw new AppError(
        'CONFLICT',
        'Someone else changed this runtime at the same time. Check its state and try again.',
      );
    }

    this.events?.publish(record.projectId, { type: 'runtime.changed', status: to });

    return next;
  }

  private async fail(
    record: RuntimeRecord,
    error: unknown,
    actorId: string,
    fallback: string,
  ): Promise<void> {
    const message = this.userFacing(error, fallback).message;

    this.log.error(
      { err: error, runtimeId: record.id, projectId: record.projectId, status: record.status },
      'Runtime operation failed',
    );

    await this.discardWorkload(record.id);

    try {
      await this.move(record, 'FAILED', { actorId, message: message.slice(0, 500) });
    } catch (recordingError) {
      this.log.error({ err: recordingError, runtimeId: record.id }, 'Could not record the failure');
    }
  }

  private userFacing(error: unknown, fallback: string): AppError {
    if (error instanceof AppError && error.expose) return error;
    return new AppError('EXECUTION_FAILED', fallback, { expose: true, cause: error });
  }

  private async discardWorkload(runtimeId: string): Promise<void> {
    const current = await this.runtimes.findById(runtimeId);
    if (!current?.externalId) return;

    try {
      await this.provider.destroy({ externalId: current.externalId });
    } catch (error) {
      this.log.error({ err: error, runtimeId }, 'Could not remove the failed workload');
    }
  }

  private async reload(runtimeId: string): Promise<RuntimeRecord> {
    const record = await this.runtimes.findById(runtimeId);
    if (!record) throw new AppError('NOT_FOUND', 'Runtime not found');
    return record;
  }
}

function summarise(result: WorkspaceSyncResult) {
  return {
    created: result.created,
    updated: result.updated,
    deleted: result.deleted,
    unchanged: result.unchanged,
  };
}

function isInFlight(status: RuntimeStatus): boolean {
  return (
    status === 'REQUESTED' ||
    status === 'CREATING' ||
    status === 'STARTING' ||
    status === 'STOPPING'
  );
}

export function toSummary(record: RuntimeRecord): RuntimeSummary {
  if (!isRuntimeLanguage(record.language)) {
    throw new AppError(
      'INTERNAL_ERROR',
      'This runtime uses a language the platform no longer has',
      {
        context: { runtimeId: record.id, language: record.language },
      },
    );
  }

  return {
    id: record.id,
    projectId: record.projectId,
    status: record.status,
    language: record.language,
    version: record.version,
    image: record.image,
    limits: {
      cpuMillicores: record.cpuMillicores,
      memoryMb: record.memoryMb,
      pidsLimit: record.pidsLimit,
    },
    message: record.message,
    createdAt: record.createdAt.toISOString(),
    statusChangedAt: record.statusChangedAt.toISOString(),
    startedAt: record.startedAt?.toISOString() ?? null,
    stoppedAt: record.stoppedAt?.toISOString() ?? null,
  };
}

function megabytes(bytes: number): string {
  return `${String(Math.round(bytes / (1024 * 1024)))} MB`;
}
