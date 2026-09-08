import type { Database } from '../../db/client.js';

/**
 * The only code that reads or writes the terminal-session table.
 *
 * The row is not the shell. It records that one exists, whose it is and which
 * container it is in, so the platform can find it again after a restart — which
 * is the whole reason this table exists rather than the sessions living only in
 * memory.
 */

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

  /**
   * Finds a session, scoped to the project and the person.
   *
   * Both in the query rather than checked afterwards. A lookup by identifier
   * followed by a comparison is the shape that becomes a bug the day somebody
   * forgets the comparison, and the bug is one person resuming another's shell.
   */
  findOwned(id: string, projectId: string, userId: string): Promise<TerminalSessionRecord | null> {
    return this.db.projectTerminalSession.findFirst({ where: { id, projectId, userId } });
  }

  /** One person's terminals in one project, newest first. */
  listForUser(projectId: string, userId: string): Promise<TerminalSessionRecord[]> {
    return this.db.projectTerminalSession.findMany({
      where: { projectId, userId },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** How many are open in a project, across everybody. For the ceiling. */
  countForProject(projectId: string): Promise<number> {
    return this.db.projectTerminalSession.count({ where: { projectId } });
  }

  touch(id: string, at: Date): Promise<unknown> {
    return this.db.projectTerminalSession.update({ where: { id }, data: { lastActiveAt: at } });
  }

  async deleteById(id: string): Promise<void> {
    // Closing one that is already gone is what was wanted.
    await this.db.projectTerminalSession.deleteMany({ where: { id } });
  }

  /** Every session in one runtime, for when the runtime goes away. */
  listForRuntime(runtimeId: string): Promise<TerminalSessionRecord[]> {
    return this.db.projectTerminalSession.findMany({ where: { runtimeId } });
  }

  /** Sessions nobody has touched since a moment, for the idle sweep. */
  listIdle(before: Date): Promise<TerminalSessionRecord[]> {
    return this.db.projectTerminalSession.findMany({ where: { lastActiveAt: { lt: before } } });
  }
}
