import type { AlertKind, AlertSettings, AlertState } from '@platform/shared';
import type { Database } from '../../db/client.js';

/** The settings and where each alert stands, as the service reasons about them. */
export interface AlertStateRecord extends AlertSettings {
  projectId: string;
  consecutiveFailures: number;
  healthFiring: boolean;
  memoryFiring: boolean;
  lastCheckedAt: Date | null;
}

export interface AlertEventRecord {
  id: string;
  kind: AlertKind;
  state: AlertState;
  message: string;
  notified: boolean;
  createdAt: Date;
}

/** Who hears about a project's alerts: its owner, and nobody else. */
export interface AlertRecipient {
  email: string;
  emailVerified: boolean;
  username: string;
  projectName: string;
}

const FIELDS = {
  projectId: true,
  enabled: true,
  failuresBeforeAlert: true,
  memoryPercent: true,
  consecutiveFailures: true,
  healthFiring: true,
  memoryFiring: true,
  lastCheckedAt: true,
} as const;

export class AlertRepository {
  constructor(private readonly db: Database) {}

  find(projectId: string): Promise<AlertStateRecord | null> {
    return this.db.projectAlertSettings.findUnique({ where: { projectId }, select: FIELDS });
  }

  /**
   * Replaces the settings, and starts the state again.
   *
   * A count of failures made under a threshold of three means nothing under a
   * threshold of ten, and an alert that was firing under settings that no longer
   * exist would clear with a message about a condition nobody is watching.
   */
  async save(projectId: string, settings: AlertSettings): Promise<void> {
    const reset = {
      consecutiveFailures: 0,
      healthFiring: false,
      memoryFiring: false,
      lastCheckedAt: null,
    };
    await this.db.projectAlertSettings.upsert({
      where: { projectId },
      create: { projectId, ...settings, ...reset },
      update: { ...settings, ...reset },
    });
  }

  /**
   * Takes the projects due a check, and marks them taken.
   *
   * One statement, with `SKIP LOCKED`, for the same reason the job claim is: two
   * workers must not both check a project and both send the email about it.
   */
  async claimDue(intervalMs: number, limit: number): Promise<AlertStateRecord[]> {
    // Due by the database's clock, which is also what stamps "lastCheckedAt".
    const rows = await this.db.$queryRaw<{ projectId: string }[]>`
      UPDATE "project_alert_settings"
      SET "lastCheckedAt" = NOW()
      WHERE "projectId" IN (
        SELECT "projectId" FROM "project_alert_settings"
        WHERE "enabled" = true
          AND (
            "lastCheckedAt" IS NULL
            OR "lastCheckedAt" < NOW() - (${intervalMs}::double precision * INTERVAL '1 millisecond')
          )
        ORDER BY "lastCheckedAt" ASC NULLS FIRST
        FOR UPDATE SKIP LOCKED
        LIMIT ${limit}
      )
      RETURNING "projectId"
    `;
    if (rows.length === 0) return [];
    return this.db.projectAlertSettings.findMany({
      where: { projectId: { in: rows.map((row) => row.projectId) } },
      select: FIELDS,
    });
  }

  async saveState(
    projectId: string,
    state: { consecutiveFailures: number; healthFiring: boolean; memoryFiring: boolean },
  ): Promise<void> {
    // updateMany: the project may have been deleted since it was claimed.
    await this.db.projectAlertSettings.updateMany({ where: { projectId }, data: state });
  }

  async recordEvent(
    projectId: string,
    event: { kind: AlertKind; state: AlertState; message: string; notified: boolean },
  ): Promise<void> {
    await this.db.projectAlertEvent.create({
      data: { projectId, ...event, message: event.message.slice(0, 500) },
    });
  }

  async events(projectId: string, limit: number): Promise<AlertEventRecord[]> {
    const rows = await this.db.projectAlertEvent.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: { id: true, kind: true, state: true, message: true, notified: true, createdAt: true },
    });
    return rows.map((row) => ({
      ...row,
      kind: row.kind as AlertKind,
      state: row.state as AlertState,
    }));
  }

  async recipient(projectId: string): Promise<AlertRecipient | null> {
    const project = await this.db.project.findUnique({
      where: { id: projectId },
      select: {
        name: true,
        owner: { select: { email: true, emailVerifiedAt: true, username: true } },
      },
    });
    if (!project) return null;
    return {
      email: project.owner.email,
      emailVerified: project.owner.emailVerifiedAt !== null,
      username: project.owner.username,
      projectName: project.name,
    };
  }
}
