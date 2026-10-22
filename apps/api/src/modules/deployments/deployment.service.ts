import { randomBytes } from 'node:crypto';
import {
  DEPLOYMENT_TRANSITIONS,
  canTransition,
  deploymentConfigProblem,
  readPackageJson,
  type DeploymentConfig,
  type DeploymentLogResponse,
  type DeploymentStateResponse,
  type DeploymentStatus,
  type DeploymentSummary,
  type ResourceLimits,
} from '@platform/shared';
import type { Logger } from 'pino';
import { AppError } from '../../errors/app-error.js';
import type { BuildHandle, DeploymentProvider } from '../../deploy/provider.js';
import type { ProjectEventPublisher } from '../../events/project-event-bus.js';
import type { StorageProvider } from '../../storage/provider.js';
import type { FileService } from '../files/file.service.js';
import type { SnapshotService } from '../snapshots/snapshot.service.js';
import { buildSnapshotArchive } from '../snapshots/snapshot-archive.js';
import { BuildLog, saveWhileRunning } from './build-log.js';
import type { DeploymentRecord, DeploymentRepository } from './deployment.repository.js';

interface StoredArtifact {
  artifactKey?: string;
  artifactBytes?: number;
  fileCount?: number;
}

interface EnvironmentSource {
  forRuntime(projectId: string): Promise<Record<string, string>>;
}

interface RuntimeDetector {
  detect(projectId: string): Promise<{ image: string } | null>;
}

interface AddressSource {
  ensureSubdomain(projectId: string): Promise<string>;
  addressOf(projectId: string): Promise<{ subdomain: string; url: string } | null>;
  releaseAddress(label: string): string;
}

export type ServingDeployment =
  | { kind: 'static'; artifactKey: string }
  | { kind: 'server'; target: { host: string; port: number } };

const LIVE_LOG_SAVE_MS = 2_000;

export interface DeploymentServiceOptions {
  maxPerProject: number;
  limits: ResourceLimits;
  maxLogBytes: number;
}

export class DeploymentService {
  constructor(
    private readonly deployments: DeploymentRepository,
    private readonly files: FileService,
    private readonly snapshots: SnapshotService,
    private readonly storage: StorageProvider,
    private readonly provider: DeploymentProvider,
    private readonly runtimes: RuntimeDetector,
    private readonly addresses: AddressSource,
    private readonly variables: EnvironmentSource,
    private readonly secrets: EnvironmentSource,
    private readonly databases: EnvironmentSource,
    private readonly options: DeploymentServiceOptions,
    private readonly log: Logger,
  ) {}

  private events: ProjectEventPublisher | undefined;

  useEvents(events: ProjectEventPublisher): void {
    this.events = events;
  }

  private artifacts: { forget(storageKey: string): void } | undefined;

  useArtifacts(artifacts: { forget(storageKey: string): void }): void {
    this.artifacts = artifacts;
  }

  private logs:
    | {
        record(input: {
          projectId: string;
          source: 'DEPLOYMENT';
          sourceId: string;
          stream: 'stdout' | 'stderr';
          chunk: string;
        }): void;
      }
    | undefined;

  useLogs(logs: NonNullable<typeof this.logs>): void {
    this.logs = logs;
  }

  private queue:
    | {
        enqueue(
          type: 'DEPLOYMENT_BUILD',
          payload: unknown,
          options: { projectId: string },
        ): Promise<unknown>;
      }
    | undefined;

  useJobQueue(queue: NonNullable<typeof this.queue>): void {
    this.queue = queue;
  }

  private quotas:
    { require(projectId: string, kind: 'DEPLOYMENTS' | 'BUILDS'): Promise<void> } | undefined;

  useQuotas(quotas: NonNullable<typeof this.quotas>): void {
    this.quotas = quotas;
  }

  unavailableReason(): Promise<string | null> {
    return this.provider.unavailableReason();
  }

  async describe(projectId: string): Promise<DeploymentStateResponse> {
    const [records, config, live, unavailableReason, suggestion] = await Promise.all([
      this.deployments.listForProject(projectId, this.options.maxPerProject),
      this.deployments.findConfig(projectId),
      this.deployments.findServing(projectId),
      this.unavailableReason(),
      this.suggest(projectId),
    ]);

    const address = await this.addresses.addressOf(projectId);

    return {
      deployments: records.map((record) => this.summarize(record)),
      subdomain: address?.subdomain ?? null,
      url: address?.url ?? null,
      config: config
        ? {
            target: config.target,
            buildCommand: config.buildCommand,
            outputDirectory: config.outputDirectory,
            startCommand: config.startCommand,
          }
        : null,
      suggestion,
      liveId: live?.id ?? null,
      unavailableReason,
      limit: this.options.maxPerProject,
    };
  }

  async setConfig(projectId: string, config: DeploymentConfig): Promise<DeploymentStateResponse> {
    const problem = deploymentConfigProblem(config);
    if (problem) {
      throw new AppError('VALIDATION_FAILED', problem, { expose: true });
    }

    await this.deployments.setConfig(projectId, {
      target: config.target,
      buildCommand: config.buildCommand,
      outputDirectory: config.outputDirectory,
      startCommand: config.startCommand,
    });

    this.log.info({ projectId, target: config.target }, 'deployment configuration set');
    this.events?.publish(projectId, { type: 'deployments.changed' });

    return this.describe(projectId);
  }

  async suggest(projectId: string): Promise<DeploymentConfig | null> {
    const tree = await this.files.listTree(projectId);
    const paths = tree.entries.filter((entry) => entry.type === 'FILE').map((entry) => entry.path);

    if (paths.length === 0) return null;

    const manifest = paths.includes('package.json')
      ? readPackageJson((await this.files.read(projectId, 'package.json')).content)
      : {};

    const scripts = manifest.packageScripts ?? {};

    if (scripts.build) {
      const output = ['dist', 'build', 'out', 'public'].find((directory) =>
        paths.some((path) => path === directory || path.startsWith(`${directory}/`)),
      );

      if (!scripts.start && output) {
        return {
          target: 'STATIC',
          buildCommand: 'npm run build',
          outputDirectory: output,
          startCommand: null,
        };
      }
    }

    if (scripts.start) {
      return {
        target: 'SERVER',
        buildCommand: scripts.build ? 'npm run build' : null,
        outputDirectory: null,
        startCommand: 'npm start',
      };
    }

    if (paths.includes('index.html')) {
      return { target: 'STATIC', buildCommand: null, outputDirectory: '.', startCommand: null };
    }

    return null;
  }

  async create(
    projectId: string,
    userId: string,
    input: { note?: string | undefined },
  ): Promise<DeploymentSummary> {
    const reason = await this.provider.unavailableReason();
    if (reason) throw new AppError('SERVICE_UNAVAILABLE', reason, { expose: true });

    const config = await this.deployments.findConfig(projectId);
    if (!config) {
      throw new AppError(
        'PRECONDITION_FAILED',
        'Say how this project is built and started before deploying it.',
      );
    }

    const detected = await this.runtimes.detect(projectId);
    if (!detected) {
      throw new AppError(
        'PRECONDITION_FAILED',
        'The platform cannot tell what this project is written in, so it cannot build it.',
      );
    }

    await this.quotas?.require(projectId, 'DEPLOYMENTS');
    await this.quotas?.require(projectId, 'BUILDS');

    const note = input.note?.trim() ? input.note.trim() : null;

    await this.addresses.ensureSubdomain(projectId);
    const address = await this.addresses.addressOf(projectId);

    if (!address) {
      throw new AppError(
        'CONFLICT',
        'This project could not be given a deployment address. Choose one yourself and try again.',
      );
    }

    await this.prune(projectId);

    const snapshot = await this.snapshots.captureForDeployment(
      projectId,
      userId,
      note ?? new Date().toISOString(),
    );

    const record = await this.deployments.create({
      projectId,
      target: config.target,
      note,
      buildCommand: config.buildCommand,
      outputDirectory: config.outputDirectory,
      startCommand: config.startCommand,
      snapshotId: snapshot.id,
      requestedById: userId,
      releaseLabel: await this.uniqueReleaseLabel(),
    });

    this.events?.publish(projectId, { type: 'deployments.changed' });

    if (this.queue) {
      await this.queue.enqueue(
        'DEPLOYMENT_BUILD',
        { deploymentId: record.id, actorId: userId },
        { projectId },
      );
      return this.summarize(record);
    }

    return this.build(record.id, projectId, userId);
  }

  async buildRequested(deploymentId: string, actorId: string): Promise<void> {
    const record = await this.deployments.findByIdAnywhere(deploymentId);

    if (!record) {
      this.log.info({ deploymentId }, 'a queued build had nothing to build');
      return;
    }

    if (record.status !== 'REQUESTED') {
      this.log.info(
        { deploymentId, status: record.status },
        'a queued build found the deployment already moved on',
      );
      return;
    }

    await this.build(deploymentId, record.projectId, actorId);
  }

  async abandonRequested(deploymentId: string, reason: string): Promise<void> {
    const record = await this.deployments.findByIdAnywhere(deploymentId);
    if (!record || record.status !== 'REQUESTED') return;

    await this.move(record, 'FAILED', record.requestedById ?? '', reason, {
      stoppedAt: new Date(),
    });

    this.log.warn(
      { deploymentId, projectId: record.projectId },
      'a requested deployment was abandoned',
    );
    this.events?.publish(record.projectId, { type: 'deployments.changed' });
  }

  private async build(
    deploymentId: string,
    projectId: string,
    userId: string,
  ): Promise<DeploymentSummary> {
    const record = await this.deployments.findById(projectId, deploymentId);
    if (!record) throw new AppError('NOT_FOUND', 'There is no deployment with that identifier');

    const config = await this.deployments.findConfig(projectId);
    if (!config) {
      throw new AppError(
        'PRECONDITION_FAILED',
        'Say how this project is built and started before deploying it.',
      );
    }

    const detected = await this.runtimes.detect(projectId);
    if (!detected) {
      throw new AppError(
        'PRECONDITION_FAILED',
        'The platform cannot tell what this project is written in, so it cannot build it.',
      );
    }

    const address = await this.addresses.addressOf(projectId);
    if (!address) {
      throw new AppError(
        'CONFLICT',
        'This project has no deployment address, so there is nowhere to publish it.',
      );
    }

    const snapshotId = record.snapshotId;
    if (!snapshotId) {
      throw new AppError(
        'PRECONDITION_FAILED',
        'The version this deployment was meant to be built from is no longer available.',
      );
    }

    const building = await this.move(record, 'BUILDING', userId, null);
    const log = new BuildLog(this.options.maxLogBytes);
    const live = saveWhileRunning(
      log,
      () =>
        this.deployments
          .recordBuild(record.id, { log: log.text(), truncated: log.truncated })
          .catch((error: unknown) => {
            this.log.warn(
              { err: error, projectId, deploymentId: record.id },
              'build log not saved while building',
            );
          }),
      LIVE_LOG_SAVE_MS,
    );

    let workload: BuildHandle | undefined;

    try {
      const entries = (await this.snapshots.readEntries(projectId, snapshotId)).entries;
      const environment = await this.environmentFor(projectId);

      workload = await this.provider.build({
        deploymentId: record.id,
        projectId,
        image: detected.image,
        entries,
        buildCommand: config.buildCommand,
        outputDirectory: config.outputDirectory,
        environment,
        limits: this.options.limits,
        onLog: (chunk) => log.write(chunk),
      });
      await live.stop();

      const published =
        config.target === 'STATIC'
          ? await this.publishStatic(record.id, projectId, workload, config.outputDirectory ?? '.')
          : await this.publishServer(
              building,
              userId,
              workload,
              config.startCommand ?? '',
              environment,
            );

      const ready =
        published.record.status === 'BUILDING'
          ? await this.move(published.record, 'STARTING', userId, null)
          : published.record;

      const running = await this.move(ready, 'RUNNING', userId, null, {
        startedAt: new Date(),
        url: address.url,
      });

      await this.deployments.recordBuild(record.id, {
        log: log.text(),
        truncated: log.truncated,
        ...published.stored,
      });

      this.log.info({ projectId, deploymentId: record.id }, 'deployment running');

      if (config.target === 'SERVER') await this.stopSuperseded(projectId, record.id, userId);

      this.events?.publish(projectId, { type: 'deployments.changed' });

      return this.summarize((await this.deployments.findById(projectId, record.id)) ?? running);
    } catch (error) {
      const message =
        error instanceof AppError && error.expose
          ? error.message
          : 'This deployment could not be built.';

      this.log.error({ err: error, projectId, deploymentId: record.id }, 'deployment failed');

      await live.stop();
      await this.deployments
        .recordBuild(record.id, { log: log.text(), truncated: log.truncated })
        .catch(() => undefined);

      if (workload) await this.provider.destroy(workload).catch(() => undefined);

      await this.move(building, 'FAILED', userId, message, { stoppedAt: new Date() });
      this.events?.publish(projectId, { type: 'deployments.changed' });

      throw error instanceof AppError
        ? error
        : new AppError('EXECUTION_FAILED', message, { expose: true });
    }
  }

  private async publishStatic(
    deploymentId: string,
    projectId: string,
    workload: BuildHandle,
    outputDirectory: string,
  ): Promise<{ record: DeploymentRecord; stored: StoredArtifact }> {
    const reason = await this.storage.unavailableReason();
    if (reason) throw new AppError('SERVICE_UNAVAILABLE', reason, { expose: true });

    const { files } = await this.provider.collect(workload, outputDirectory);

    if (files.length === 0) {
      throw new AppError(
        'PRECONDITION_FAILED',
        `The build left nothing in "${outputDirectory}", so there is nothing to publish.`,
      );
    }

    const { archive, fileCount } = await buildSnapshotArchive(
      files.map((file) => ({ path: file.path, content: file.content })),
    );

    const storageKey = `deployments/${projectId}/${deploymentId}.tar`;
    await this.storage.put(storageKey, archive, 'application/x-tar');

    await this.provider.destroy(workload).catch((error: unknown) => {
      this.log.error(
        { err: error, deploymentId },
        'a build workload could not be removed and is now orphaned',
      );
    });

    const record = await this.deployments.findById(projectId, deploymentId);
    if (!record) throw new AppError('NOT_FOUND', 'There is no deployment with that identifier');

    return {
      record,
      stored: { artifactKey: storageKey, artifactBytes: archive.byteLength, fileCount },
    };
  }

  private async publishServer(
    building: DeploymentRecord,
    userId: string,
    workload: BuildHandle,
    startCommand: string,
    environment: Record<string, string>,
  ): Promise<{ record: DeploymentRecord; stored: StoredArtifact }> {
    const starting = await this.move(building, 'STARTING', userId, null, {
      provider: this.provider.name,
      externalId: workload.externalId,
      executionHost: workload.host ?? null,
    });

    const handle = await this.provider.serve(workload, {
      deploymentId: building.id,
      startCommand,
      environment,

      onOutput: ({ stream, chunk }) => {
        this.logs?.record({
          projectId: building.projectId,
          source: 'DEPLOYMENT',
          sourceId: building.id,
          stream,
          chunk,
        });
      },

      onExit: (code) => {
        void this.recordExit(building.projectId, building.id, code);
      },
    });

    return {
      record: await this.moveContainerPort(starting, handle.containerPort),
      stored: {},
    };
  }

  private async recordExit(
    projectId: string,
    deploymentId: string,
    code: number | null,
  ): Promise<void> {
    const message =
      code === null
        ? 'This deployment stopped and the platform could not learn why.'
        : `This deployment exited with code ${String(code)}.`;

    try {
      const record = await this.deployments.findById(projectId, deploymentId);

      if (!record || record.status !== 'RUNNING') return;

      this.logs?.record({
        projectId,
        source: 'DEPLOYMENT',
        sourceId: deploymentId,
        stream: 'stderr',
        chunk: `\n${message}\n`,
      });

      await this.move(record, 'FAILED', record.requestedById ?? '', message, {
        stoppedAt: new Date(),
      });

      this.log.warn({ projectId, deploymentId, code }, 'a running deployment exited');
      this.events?.publish(projectId, { type: 'deployments.changed' });
    } catch (error) {
      this.log.error({ err: error, projectId, deploymentId }, 'a deployment exit was not recorded');
    }
  }

  private async environmentFor(projectId: string): Promise<Record<string, string>> {
    const [database, variables, secrets] = await Promise.all([
      this.databases.forRuntime(projectId),
      this.variables.forRuntime(projectId),
      this.secrets.forRuntime(projectId),
    ]);
    return { ...database, ...variables, ...secrets };
  }

  async stop(projectId: string, deploymentId: string, userId: string): Promise<DeploymentSummary> {
    const record = await this.require(projectId, deploymentId);

    if (record.status === 'STOPPED' || record.status === 'FAILED') {
      return this.summarize(record);
    }

    const stopping = await this.move(record, 'STOPPING', userId, null);

    if (record.externalId) {
      try {
        await this.provider.stop({ externalId: record.externalId });
      } catch (error) {
        const message = 'This deployment could not be stopped.';
        this.log.error({ err: error, projectId, deploymentId }, message);
        await this.move(stopping, 'FAILED', userId, message, { stoppedAt: new Date() });
        throw new AppError('EXECUTION_FAILED', message, { expose: true });
      }
    }

    const stopped = await this.move(stopping, 'STOPPED', userId, null, { stoppedAt: new Date() });

    this.log.info({ projectId, deploymentId }, 'deployment stopped');
    this.events?.publish(projectId, { type: 'deployments.changed' });

    return this.summarize(stopped);
  }

  async remove(projectId: string, deploymentId: string): Promise<void> {
    const record = await this.require(projectId, deploymentId);

    if (record.status !== 'STOPPED' && record.status !== 'FAILED') {
      throw new AppError('PRECONDITION_FAILED', 'Stop this deployment before removing it.');
    }

    await this.release(record);
    await this.deployments.deleteById(projectId, deploymentId);

    this.log.info({ projectId, deploymentId }, 'deployment removed');
    this.events?.publish(projectId, { type: 'deployments.changed' });
  }

  async releaseProject(projectId: string): Promise<void> {
    const records = await this.deployments.listForProject(projectId, Number.MAX_SAFE_INTEGER);
    for (const record of records) await this.release(record);
  }

  private async moveContainerPort(
    record: DeploymentRecord,
    containerPort: number,
  ): Promise<DeploymentRecord> {
    await this.deployments.recordPort(record.id, containerPort);
    return { ...record, containerPort };
  }

  async serving(projectId: string): Promise<ServingDeployment | null> {
    return this.servingRecord(await this.deployments.findServing(projectId));
  }

  async servingRelease(label: string): Promise<ServingDeployment | null> {
    return this.servingRecord(await this.deployments.findByReleaseLabel(label));
  }

  private async servingRecord(record: DeploymentRecord | null): Promise<ServingDeployment | null> {
    if (!record) return null;

    if (record.target === 'STATIC') {
      return record.artifactKey ? { kind: 'static', artifactKey: record.artifactKey } : null;
    }

    if (!record.externalId || record.containerPort === null) return null;

    const target = await this.provider.target({
      externalId: record.externalId,
      containerPort: record.containerPort,
    });

    return target ? { kind: 'server', target } : null;
  }

  async buildLog(projectId: string, deploymentId: string): Promise<DeploymentLogResponse> {
    const record = await this.require(projectId, deploymentId);
    return { log: record.buildLog ?? '', truncated: record.buildLogTruncated };
  }

  async rollback(
    projectId: string,
    deploymentId: string,
    userId: string,
    input: { note?: string | undefined },
  ): Promise<DeploymentSummary> {
    const target = await this.require(projectId, deploymentId);

    if (target.target === 'STATIC' ? !target.artifactKey : !target.snapshotId) {
      throw new AppError(
        'PRECONDITION_FAILED',
        'That release never finished building, so there is nothing to go back to.',
        { expose: true },
      );
    }

    const live = await this.deployments.findServing(projectId);
    if (live?.id === target.id) {
      throw new AppError('PRECONDITION_FAILED', 'That release is already live.', { expose: true });
    }

    const reason = await this.provider.unavailableReason();
    if (reason) throw new AppError('SERVICE_UNAVAILABLE', reason, { expose: true });

    await this.quotas?.require(projectId, 'DEPLOYMENTS');

    const note = input.note?.trim()
      ? input.note.trim()
      : `Rolled back to ${target.note ?? target.createdAt.toISOString()}`;

    await this.addresses.ensureSubdomain(projectId);

    await this.prune(projectId);

    const record = await this.deployments.create({
      projectId,
      target: target.target,
      note,
      buildCommand: target.buildCommand,
      outputDirectory: target.outputDirectory,
      startCommand: target.startCommand,
      snapshotId: target.snapshotId,
      requestedById: userId,
      releaseLabel: await this.uniqueReleaseLabel(),
      rolledBackFromId: target.id,
    });

    this.events?.publish(projectId, { type: 'deployments.changed' });

    if (target.target === 'STATIC') return this.republishStatic(record, target, userId);

    if (this.queue) {
      await this.queue.enqueue(
        'DEPLOYMENT_BUILD',
        { deploymentId: record.id, actorId: userId },
        { projectId },
      );
      return this.summarize(record);
    }

    return this.build(record.id, projectId, userId);
  }

  private async republishStatic(
    record: DeploymentRecord,
    source: DeploymentRecord,
    userId: string,
  ): Promise<DeploymentSummary> {
    const artifactKey = source.artifactKey;
    if (!artifactKey) {
      throw new AppError('PRECONDITION_FAILED', 'That release has no stored output.');
    }

    const building = await this.move(record, 'BUILDING', userId, null);

    try {
      const reason = await this.storage.unavailableReason();
      if (reason) throw new AppError('SERVICE_UNAVAILABLE', reason, { expose: true });

      const stream = await this.storage.get(artifactKey);
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
      const archive = Buffer.concat(chunks);
      const key = `deployments/${record.projectId}/${record.id}.tar`;
      await this.storage.put(key, archive, 'application/x-tar');

      await this.deployments.recordBuild(record.id, {
        artifactKey: key,
        artifactBytes: archive.byteLength,
        ...(source.fileCount === null ? {} : { fileCount: source.fileCount }),
      });

      const starting = await this.move(building, 'STARTING', userId, null);
      const address = await this.addresses.addressOf(record.projectId);

      const running = await this.move(starting, 'RUNNING', userId, null, {
        url: address?.url ?? null,
        startedAt: new Date(),
      });

      this.events?.publish(record.projectId, { type: 'deployments.changed' });

      return this.summarize(
        (await this.deployments.findById(record.projectId, record.id)) ?? running,
      );
    } catch (error) {
      const message =
        error instanceof AppError && error.expose
          ? error.message
          : 'That release could not be published again.';

      await this.move(building, 'FAILED', userId, message, { stoppedAt: new Date() });
      this.events?.publish(record.projectId, { type: 'deployments.changed' });
      throw error;
    }
  }

  private async uniqueReleaseLabel(): Promise<string> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const label = randomReleaseLabel();
      if (!(await this.deployments.releaseLabelExists(label))) return label;
    }

    throw new AppError('CONFLICT', 'A release address could not be assigned. Try again.');
  }

  releaseExists(label: string): Promise<boolean> {
    return this.deployments.releaseLabelExists(label);
  }

  private summarize(record: DeploymentRecord): DeploymentSummary {
    return toSummary(
      record,
      record.releaseLabel && record.status === 'RUNNING'
        ? this.addresses.releaseAddress(record.releaseLabel)
        : null,
    );
  }

  private async require(projectId: string, deploymentId: string): Promise<DeploymentRecord> {
    const record = await this.deployments.findById(projectId, deploymentId);
    if (!record) throw new AppError('NOT_FOUND', 'There is no deployment with that identifier');
    return record;
  }

  private async release(record: DeploymentRecord): Promise<void> {
    if (record.externalId) {
      if (record.status === 'RUNNING') {
        await this.move(record, 'STOPPING', record.requestedById ?? '', null).catch(
          () => undefined,
        );
      }
      await this.provider.destroy({ externalId: record.externalId }).catch((error: unknown) => {
        this.log.error(
          { err: error, projectId: record.projectId, deploymentId: record.id },
          'a deployment could not be removed from its provider and is now orphaned',
        );
      });
    }

    if (record.artifactKey) {
      this.artifacts?.forget(record.artifactKey);

      await this.storage.delete(record.artifactKey).catch((error: unknown) => {
        this.log.error(
          { err: error, projectId: record.projectId, storageKey: record.artifactKey },
          'a deployment artifact could not be removed and is now orphaned',
        );
      });
    }
  }

  private async move(
    record: DeploymentRecord,
    to: DeploymentStatus,
    actorId: string,
    message: string | null,
    extra: {
      provider?: string | null;
      externalId?: string | null;
      executionHost?: string | null;
      url?: string | null;
      startedAt?: Date;
      stoppedAt?: Date;
    } = {},
  ): Promise<DeploymentRecord> {
    if (!canTransition(DEPLOYMENT_TRANSITIONS, record.status, to)) {
      throw new Error(`Illegal deployment transition ${record.status} -> ${to}`);
    }

    const next = await this.deployments.transition({
      deploymentId: record.id,
      from: record.status,
      expectedRevision: record.revision,
      to,
      actorId,
      message,
      ...extra,
    });

    if (!next) {
      throw new AppError(
        'CONFLICT',
        'Someone else changed this deployment at the same time. Check its state and try again.',
      );
    }

    return next;
  }

  async enforceDiskLimit(limitBytes: number): Promise<{ checked: number; stopped: number }> {
    let checked = 0;
    let stopped = 0;
    for (const release of await this.deployments.listRunningServers()) {
      if (!release.externalId) continue;
      const used = await this.provider.diskUsage({ externalId: release.externalId });
      checked += 1;
      if (used === null || used <= limitBytes) continue;

      this.log.warn(
        { projectId: release.projectId, deploymentId: release.id, used, limitBytes },
        'a deployment went over its disk limit and was stopped',
      );
      this.logs?.record({
        projectId: release.projectId,
        source: 'DEPLOYMENT',
        sourceId: release.id,
        stream: 'stderr',
        chunk: `\nStopped: this deployment wrote ${String(Math.round(used / 1048576))} MB to disk, over its ${String(Math.round(limitBytes / 1048576))} MB limit.\n`,
      });
      try {
        await this.stop(release.projectId, release.id, release.requestedById ?? '');
        stopped += 1;
      } catch (error) {
        this.log.error(
          { err: error, deploymentId: release.id },
          'a deployment over its disk limit could not be stopped',
        );
      }
    }
    return { checked, stopped };
  }

  private async stopSuperseded(projectId: string, liveId: string, userId: string): Promise<void> {
    const releases = await this.deployments.listForProject(projectId, this.options.maxPerProject);
    for (const release of releases) {
      if (release.id === liveId || release.target !== 'SERVER' || release.status !== 'RUNNING') {
        continue;
      }
      await this.stop(projectId, release.id, userId).catch((error: unknown) => {
        this.log.error(
          { err: error, projectId, deploymentId: release.id },
          'a superseded server release could not be stopped',
        );
      });
    }
  }

  private async prune(projectId: string): Promise<void> {
    const held = await this.deployments.countForProject(projectId);
    const excess = held - (this.options.maxPerProject - 1);
    if (excess <= 0) return;

    for (const record of await this.deployments.listPrunable(projectId, excess)) {
      await this.release(record);
      await this.deployments.deleteById(projectId, record.id);
    }
  }
}

function toSummary(record: DeploymentRecord, releaseUrl: string | null): DeploymentSummary {
  return {
    id: record.id,
    status: record.status,
    target: record.target,
    note: record.note,
    buildCommand: record.buildCommand,
    outputDirectory: record.outputDirectory,
    startCommand: record.startCommand,
    snapshotId: record.snapshotId,
    url: record.url,
    message: record.message,
    fileCount: record.fileCount,
    artifactBytes: record.artifactBytes,
    hasLog: (record.buildLog ?? '').length > 0,
    requestedBy: record.requestedBy?.username ?? null,
    createdAt: record.createdAt.toISOString(),
    statusChangedAt: record.statusChangedAt.toISOString(),
    startedAt: record.startedAt?.toISOString() ?? null,
    stoppedAt: record.stoppedAt?.toISOString() ?? null,
    releaseUrl,
    rolledBackFromId: record.rolledBackFromId,
  };
}

const LABEL_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const LABEL_LENGTH = 10;

function randomReleaseLabel(): string {
  const bytes = randomBytes(LABEL_LENGTH);
  let label = '';

  for (const byte of bytes) {
    label += LABEL_ALPHABET[byte % LABEL_ALPHABET.length];
  }

  return label;
}
