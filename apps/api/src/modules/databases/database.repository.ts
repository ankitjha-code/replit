import type { Database } from '../../db/client.js';
import type { DatabaseStatus } from '../../generated/prisma/index.js';

/**
 * The only code that reads or writes the project_databases table.
 *
 * Note what this table does **not** hold: the host and the port of the server
 * the database lives in. Both are read from configuration when a connection
 * string is assembled, so moving that server does not strand every row
 * describing a database that is still perfectly reachable.
 */

export interface DatabaseRecord {
  id: string;
  projectId: string;
  status: DatabaseStatus;
  name: string;
  role: string;
  password: Uint8Array;
  message: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export class DatabaseRepository {
  constructor(private readonly db: Database) {}

  findByProject(projectId: string): Promise<DatabaseRecord | null> {
    return this.db.projectDatabase.findUnique({ where: { projectId } });
  }

  /**
   * Records the intention to have a database, and loses the race if one exists.
   *
   * The unique constraint on the project is what decides, not a check here: two
   * concurrent requests both find nothing, and only the database can settle it.
   */
  create(input: {
    projectId: string;
    name: string;
    role: string;
    password: Buffer;
  }): Promise<DatabaseRecord> {
    return this.db.projectDatabase.create({
      data: {
        projectId: input.projectId,
        name: input.name,
        role: input.role,
        // Copied into a fresh Uint8Array: Prisma's generated input type will not
        // accept a Buffer whose backing store it cannot prove is an ArrayBuffer.
        password: Uint8Array.from(input.password),
        status: 'CREATING',
      },
    });
  }

  markReady(id: string): Promise<DatabaseRecord> {
    return this.db.projectDatabase.update({
      where: { id },
      data: { status: 'READY', message: null },
    });
  }

  markFailed(id: string, message: string): Promise<DatabaseRecord> {
    return this.db.projectDatabase.update({
      where: { id },
      data: { status: 'FAILED', message },
    });
  }

  setPassword(id: string, password: Buffer): Promise<DatabaseRecord> {
    return this.db.projectDatabase.update({
      where: { id },
      data: { password: Uint8Array.from(password) },
    });
  }

  /** Succeeds when there is no row, which is the state the caller wants. */
  async deleteByProject(projectId: string): Promise<void> {
    await this.db.projectDatabase.deleteMany({ where: { projectId } });
  }
}
