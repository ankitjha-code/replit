import type { Database } from '../db/client.js';

/**
 * The only code that reads what a restart interrupted.
 *
 * Every query here answers the same question in a different table: what did
 * this platform say was in the middle of happening? A status like `STARTING`
 * or `BUILDING` describes something a process was carrying, and a process that
 * is gone is not carrying anything. Those rows are the whole input to recovery.
 */

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

  /**
   * Runtimes in a state a process was supposed to be carrying.
   *
   * `RUNNING` is included, and it is not obviously in-between: a running
   * runtime needs nobody holding it. It is here because the row saying
   * `RUNNING` is a claim about a container, and a restart is the one moment the
   * platform gets to check whether the claim survived — a machine rebooted
   * while the control plane was down leaves a great many rows saying `RUNNING`
   * about containers that are not.
   */
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

  /**
   * Databases whose provisioning was interrupted.
   *
   * `CREATING` is written before the statements run, deliberately, so that a
   * database made by a process that then died is still named somewhere. This is
   * what reads those names back.
   */
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

  /**
   * The payloads of work still outstanding.
   *
   * Read whole rather than queried into, because the payload is a JSON column
   * whose shape differs per job type and the question being asked of it —
   * "does anything still intend to build this deployment" — is one line of
   * TypeScript against a list that is small by construction: a queue with
   * enough outstanding work for this to matter has a bigger problem than a
   * restart.
   */
  listOutstandingJobs(): Promise<{ id: string; type: string; payload: unknown }[]> {
    return this.db.job.findMany({
      where: { status: { in: ['QUEUED', 'RUNNING'] } },
      select: { id: true, type: true, payload: true },
    });
  }
}
