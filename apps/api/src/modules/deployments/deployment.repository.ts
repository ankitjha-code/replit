import type { DeploymentStatus, DeploymentTarget } from '@platform/shared';
import type { Database } from '../../db/client.js';

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
  releaseLabel: string | null;
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

  listForProject(projectId: string, limit: number): Promise<DeploymentRecord[]> {
    return this.db.deployment.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: FIELDS,
    });
  }

  findById(projectId: string, id: string): Promise<DeploymentRecord | null> {
    return this.db.deployment.findFirst({ where: { id, projectId }, select: FIELDS });
  }

  countForProject(projectId: string): Promise<number> {
    return this.db.deployment.count({ where: { projectId } });
  }

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

  findByIdAnywhere(id: string): Promise<DeploymentRecord | null> {
    return this.db.deployment.findUnique({ where: { id }, select: FIELDS });
  }

  async recordPort(id: string, containerPort: number): Promise<void> {
    await this.db.deployment.update({ where: { id }, data: { containerPort } });
  }

  findByReleaseLabel(label: string): Promise<DeploymentRecord | null> {
    return this.db.deployment.findFirst({
      where: { releaseLabel: label, status: 'RUNNING' },
      select: FIELDS,
    });
  }

  async releaseLabelExists(label: string): Promise<boolean> {
    return (await this.db.deployment.count({ where: { releaseLabel: label } })) > 0;
  }

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
