import type { Database } from '../../db/client.js';
import type { DatabaseStatus } from '../../generated/prisma/index.js';

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

  async deleteByProject(projectId: string): Promise<void> {
    await this.db.projectDatabase.deleteMany({ where: { projectId } });
  }
}
