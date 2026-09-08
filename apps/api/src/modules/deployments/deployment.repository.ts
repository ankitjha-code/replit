import type { DeploymentStatus, DeploymentTarget } from '@platform/shared';
import type { Database } from '../../db/client.js';

/**
 * The only code that reads or writes the deployment tables.
 *
 * Three of them: the deployments themselves, the events recording how each one
 * moved, and the per-project configuration that says how a project is built.
 * They are together here because they are never read apart.
 *
 * No policy. Which transitions are legal lives in the shared lifecycle table
 * and is enforced by the service; this layer refuses one only in the sense that
 * a conditional update matches no rows.
 */

export interface DeploymentRecord {
  id: string;
  projectId: string;
  status: DeploymentStatus;
  target: DeploymentTarget;
  note: string | null;
  buildCommand: string | null;
  outputDirectory: string | null;
  startCommand: string | null;
  snapshotId: string | null;
  provider: string | null;
  externalId: string | null;
  url: string | null;
  containerPort: number | null;
  message: string | null;
  buildLog: string | null;
  buildLogTruncated: boolean;
  artifactKey: string | null;
  artifactBytes: number | null;
  fileCount: number | null;
  /** This release's own hostname label. Null for releases made before they had one. */
  releaseLabel: string | null;
  /** The release this was rolled back to, when it was made by rolling back. */
  rolledBackFromId: string | null;
  revision: number;
  requestedById: string | null;
  requestedBy: { username: string } | null;
  statusChangedAt: Date;
  startedAt: Date | null;
  stoppedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface DeploymentConfigRecord {
  id: string;
  projectId: string;
  target: DeploymentTarget;
  buildCommand: string | null;
  outputDirectory: string | null;
  startCommand: string | null;
}

const FIELDS = {
  id: true,
  projectId: true,
  status: true,
  target: true,
  note: true,
  buildCommand: true,
  outputDirectory: true,
  startCommand: true,
  snapshotId: true,
  provider: true,
  externalId: true,
  url: true,
  containerPort: true,
  message: true,
  buildLog: true,
  buildLogTruncated: true,
  artifactKey: true,
  artifactBytes: true,
  fileCount: true,
  releaseLabel: true,
  rolledBackFromId: true,
  revision: true,
  requestedById: true,
  requestedBy: { select: { username: true } },
  statusChangedAt: true,
  startedAt: true,
  stoppedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

export interface CreateDeploymentInput {
  projectId: string;
  target: DeploymentTarget;
  note: string | null;
  buildCommand: string | null;
  outputDirectory: string | null;
  startCommand: string | null;
  snapshotId: string | null;
  requestedById: string;
  /** Assigned by the service, which owns the retry when one collides. */
  releaseLabel: string;
  rolledBackFromId?: string | null;
}

export interface TransitionInput {
  deploymentId: string;
  from: DeploymentStatus;
  expectedRevision: number;
  to: DeploymentStatus;
  actorId: string | null;
  message: string | null;
  reason?: string;
  provider?: string | null;
  externalId?: string | null;
  executionHost?: string | null;
  url?: string | null;
  containerPort?: number | null;
  startedAt?: Date;
  stoppedAt?: Date;
}

export class DeploymentRepository {
  constructor(private readonly db: Database) {}

  /** Newest first, which is the order somebody reads a release history in. */
  listForProject(projectId: string, limit: number): Promise<DeploymentRecord[]> {
    return this.db.deployment.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: FIELDS,
    });
  }

  findById(projectId: string, id: string): Promise<DeploymentRecord | null> {
    // Scoped to the project as well as the id, so an identifier from one
    // project can never address another's.
    return this.db.deployment.findFirst({ where: { id, projectId }, select: FIELDS });
  }

  /**
   * The one currently expected to be serving, if any.
   *
   * A query rather than a column on the project, because "which is live" is
   * derivable from status and a second place to record it is a second place for
   * it to be wrong.
   */
  findLive(projectId: string): Promise<DeploymentRecord | null> {
    return this.db.deployment.findFirst({
      where: { projectId, status: { in: ['REQUESTED', 'BUILDING', 'STARTING', 'RUNNING'] } },
      orderBy: { createdAt: 'desc' },
      select: FIELDS,
    });
  }

  countForProject(projectId: string): Promise<number> {
    return this.db.deployment.count({ where: { projectId } });
  }

  /**
   * The oldest deployments that are finished with, for pruning.
   *
   * Only ones that have stopped or failed. Something serving is never a
   * candidate, however old it is: age is not a reason to take a site down.
   */
  listPrunable(projectId: string, take: number): Promise<DeploymentRecord[]> {
    return this.db.deployment.findMany({
      where: { projectId, status: { in: ['STOPPED', 'FAILED'] } },
      orderBy: { createdAt: 'asc' },
      take,
      select: FIELDS,
    });
  }

  async create(input: CreateDeploymentInput): Promise<DeploymentRecord> {
    const created = await this.db.deployment.create({ data: input, select: FIELDS });

    await this.db.deploymentEvent.create({
      data: {
        deploymentId: created.id,
        toStatus: created.status,
        actorId: input.requestedById,
        reason: 'Requested',
      },
    });

    return created;
  }

  /**
   * Moves a deployment from one status to another, or reports that it could not.
   *
   * Conditional on the status and revision the caller last saw, so two requests
   * racing to move the same deployment cannot both succeed. Returns null when
   * the condition did not hold, which the service reads as somebody else having
   * got there first rather than as a failure.
   */
  async transition(input: TransitionInput): Promise<DeploymentRecord | null> {
    const { count } = await this.db.deployment.updateMany({
      where: { id: input.deploymentId, status: input.from, revision: input.expectedRevision },
      data: {
        status: input.to,
        revision: { increment: 1 },
        statusChangedAt: new Date(),
        message: input.message,
        ...(input.provider === undefined ? {} : { provider: input.provider }),
        ...(input.externalId === undefined ? {} : { externalId: input.externalId }),
        ...(input.executionHost === undefined ? {} : { executionHost: input.executionHost }),
        ...(input.url === undefined ? {} : { url: input.url }),
        ...(input.containerPort === undefined ? {} : { containerPort: input.containerPort }),
        ...(input.startedAt === undefined ? {} : { startedAt: input.startedAt }),
        ...(input.stoppedAt === undefined ? {} : { stoppedAt: input.stoppedAt }),
      },
    });

    if (count === 0) return null;

    await this.db.deploymentEvent.create({
      data: {
        deploymentId: input.deploymentId,
        fromStatus: input.from,
        toStatus: input.to,
        actorId: input.actorId,
        ...(input.reason === undefined ? {} : { reason: input.reason }),
      },
    });

    return this.db.deployment.findUnique({ where: { id: input.deploymentId }, select: FIELDS });
  }

  /**
   * Records what a build produced.
   *
   * Separate from a transition because it is not one: the log and the artifact
   * are facts about a deployment that do not move it between states, and a
   * failed build writes its log without pretending to have got anywhere.
   */
  async recordBuild(
    id: string,
    input: {
      log?: string;
      truncated?: boolean;
      artifactKey?: string;
      artifactBytes?: number;
      fileCount?: number;
    },
  ): Promise<void> {
    await this.db.deployment.update({
      where: { id },
      data: {
        ...(input.log === undefined ? {} : { buildLog: input.log }),
        ...(input.truncated === undefined ? {} : { buildLogTruncated: input.truncated }),
        ...(input.artifactKey === undefined ? {} : { artifactKey: input.artifactKey }),
        ...(input.artifactBytes === undefined ? {} : { artifactBytes: input.artifactBytes }),
        ...(input.fileCount === undefined ? {} : { fileCount: input.fileCount }),
      },
    });
  }

  /**
   * One deployment, without knowing which project it belongs to.
   *
   * The only lookup here that is not scoped to a project, and the only caller is
   * the worker: a job carries a deployment identifier and nothing else, because
   * the project is a fact about the deployment rather than something the job
   * should be able to disagree with.
   */
  findByIdAnywhere(id: string): Promise<DeploymentRecord | null> {
    return this.db.deployment.findUnique({ where: { id }, select: FIELDS });
  }

  /** Records the port a running server deployment answered on. */
  async recordPort(id: string, containerPort: number): Promise<void> {
    await this.db.deployment.update({ where: { id }, data: { containerPort } });
  }

  /**
   * The deployment currently serving a project, for the public listener.
   *
   * Only a running one. Something still building is not yet a site, and
   * something stopped is deliberately not one: both would otherwise answer a
   * request with whatever they last had.
   */
  /**
   * The release a per-release address points at.
   *
   * Only when it is running. A stopped release keeps its label so the history
   * can show what the address was, and the address stops answering — which is
   * the truth: there is nothing there to serve.
   */
  findByReleaseLabel(label: string): Promise<DeploymentRecord | null> {
    return this.db.deployment.findFirst({
      where: { releaseLabel: label, status: 'RUNNING' },
      select: FIELDS,
    });
  }

  /** True when this label is already taken, so the service can pick another. */
  async releaseLabelExists(label: string): Promise<boolean> {
    return (await this.db.deployment.count({ where: { releaseLabel: label } })) > 0;
  }

  /** Every running server deployment, across every project, for the disk check. */
  listRunningServers(): Promise<DeploymentRecord[]> {
    return this.db.deployment.findMany({
      where: { status: 'RUNNING', target: 'SERVER' },
      select: FIELDS,
    });
  }

  findServing(projectId: string): Promise<DeploymentRecord | null> {
    return this.db.deployment.findFirst({
      where: { projectId, status: 'RUNNING' },
      orderBy: { createdAt: 'desc' },
      select: FIELDS,
    });
  }

  async deleteById(projectId: string, id: string): Promise<void> {
    await this.db.deployment.deleteMany({ where: { id, projectId } });
  }

  // --- Configuration -------------------------------------------------------

  findConfig(projectId: string): Promise<DeploymentConfigRecord | null> {
    return this.db.projectDeploymentConfig.findUnique({ where: { projectId } });
  }

  setConfig(
    projectId: string,
    input: {
      target: DeploymentTarget;
      buildCommand: string | null;
      outputDirectory: string | null;
      startCommand: string | null;
    },
  ): Promise<DeploymentConfigRecord> {
    return this.db.projectDeploymentConfig.upsert({
      where: { projectId },
      create: { projectId, ...input },
      update: input,
    });
  }
}
