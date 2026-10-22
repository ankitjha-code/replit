import type { Database } from '../../db/client.js';

export interface TerminalSessionRecord {
  id: string;
  projectId: string;
  userId: string;
  runtimeId: string;
  durable: boolean;
  rows: number;
  columns: number;
  createdAt: Date;
  lastActiveAt: Date;
}

export class TerminalRepository {
  constructor(private readonly db: Database) {}

  create(input: {
    id: string;
    projectId: string;
    userId: string;
    runtimeId: string;
    durable: boolean;
    rows: number;
    columns: number;
  }): Promise<TerminalSessionRecord> {
    return this.db.projectTerminalSession.create({ data: input });
  }

  findOwned(id: string, projectId: string, userId: string): Promise<TerminalSessionRecord | null> {
    return this.db.projectTerminalSession.findFirst({ where: { id, projectId, userId } });
  }

  listForUser(projectId: string, userId: string): Promise<TerminalSessionRecord[]> {
    return this.db.projectTerminalSession.findMany({
      where: { projectId, userId },
      orderBy: { createdAt: 'desc' },
    });
  }

  countForProject(projectId: string): Promise<number> {
    return this.db.projectTerminalSession.count({ where: { projectId } });
  }

  touch(id: string, at: Date): Promise<unknown> {
    return this.db.projectTerminalSession.update({ where: { id }, data: { lastActiveAt: at } });
  }

  async deleteById(id: string): Promise<void> {
    await this.db.projectTerminalSession.deleteMany({ where: { id } });
  }

  listForRuntime(runtimeId: string): Promise<TerminalSessionRecord[]> {
    return this.db.projectTerminalSession.findMany({ where: { runtimeId } });
  }

  listIdle(before: Date): Promise<TerminalSessionRecord[]> {
    return this.db.projectTerminalSession.findMany({ where: { lastActiveAt: { lt: before } } });
  }
}
