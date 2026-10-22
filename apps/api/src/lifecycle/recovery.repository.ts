import type { Database } from '../db/client.js';

export interface UnfinishedRuntime {
  id: string;
  projectId: string;
  status: 'REQUESTED' | 'CREATING' | 'STARTING' | 'RUNNING' | 'STOPPING';
  revision: number;
  externalId: string | null;
  runStatus: 'IDLE' | 'STARTING' | 'RUNNING' | 'EXITED' | 'FAILED';
}

export interface UnfinishedDeployment {
  id: string;
  projectId: string;
  status: 'REQUESTED' | 'BUILDING' | 'STARTING' | 'RUNNING' | 'STOPPING';
  revision: number;
  externalId: string | null;
}

export interface ProvisioningDatabase {
  id: string;
  projectId: string;
  name: string;
  role: string;
}

export class RecoveryRepository {
  constructor(private readonly db: Database) {}

  listUnfinishedRuntimes(): Promise<UnfinishedRuntime[]> {
    return this.db.runtime.findMany({
      where: { status: { in: ['REQUESTED', 'CREATING', 'STARTING', 'RUNNING', 'STOPPING'] } },
      select: {
        id: true,
        projectId: true,
        status: true,
        revision: true,
        externalId: true,
        runStatus: true,
      },
    }) as Promise<UnfinishedRuntime[]>;
  }

  listUnfinishedDeployments(): Promise<UnfinishedDeployment[]> {
    return this.db.deployment.findMany({
      where: { status: { in: ['REQUESTED', 'BUILDING', 'STARTING', 'RUNNING', 'STOPPING'] } },
      select: {
        id: true,
        projectId: true,
        status: true,
        revision: true,
        externalId: true,
      },
    }) as Promise<UnfinishedDeployment[]>;
  }

  listProvisioningDatabases(): Promise<ProvisioningDatabase[]> {
    return this.db.projectDatabase.findMany({
      where: { status: 'CREATING' },
      select: { id: true, projectId: true, name: true, role: true },
    });
  }

  markDatabaseReady(id: string): Promise<unknown> {
    return this.db.projectDatabase.update({
      where: { id },
      data: { status: 'READY', message: null },
    });
  }

  markDatabaseFailed(id: string, message: string): Promise<unknown> {
    return this.db.projectDatabase.update({ where: { id }, data: { status: 'FAILED', message } });
  }

  listOutstandingJobs(): Promise<{ id: string; type: string; payload: unknown }[]> {
    return this.db.job.findMany({
      where: { status: { in: ['QUEUED', 'RUNNING'] } },
      select: { id: true, type: true, payload: true },
    });
  }
}
