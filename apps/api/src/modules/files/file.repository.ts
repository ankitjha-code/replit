import type { ProjectFileType } from '@platform/shared';
import type { Database } from '../../db/client.js';

export interface FileRecord {
  id: string;
  projectId: string;
  path: string;
  parentPath: string;
  name: string;
  type: ProjectFileType;
  size: number;
  checksum: string | null;
  isBinary: boolean;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface FileRecordWithContent extends FileRecord {
  content: Uint8Array | null;
}

const METADATA = {
  id: true,
  projectId: true,
  path: true,
  parentPath: true,
  name: true,
  type: true,
  size: true,
  checksum: true,
  isBinary: true,
  version: true,
  createdAt: true,
  updatedAt: true,
} as const;

export interface WriteFileInput {
  projectId: string;
  path: string;
  parentPath: string;
  name: string;
  content: Uint8Array;
  size: number;
  checksum: string;
  isBinary: boolean;
}

export class FileRepository {
  constructor(private readonly db: Database) {}

  listAll(projectId: string): Promise<FileRecord[]> {
    return this.db.projectFile.findMany({
      where: { projectId },
      select: METADATA,
      orderBy: { path: 'asc' },
    });
  }

  listAllWithContent(projectId: string): Promise<FileRecordWithContent[]> {
    return this.db.projectFile.findMany({
      where: { projectId },
      orderBy: { path: 'asc' },
    });
  }

  findByPath(projectId: string, path: string): Promise<FileRecord | null> {
    return this.db.projectFile.findUnique({
      where: { projectId_path: { projectId, path } },
      select: METADATA,
    });
  }

  findWithContent(projectId: string, path: string): Promise<FileRecordWithContent | null> {
    return this.db.projectFile.findUnique({
      where: { projectId_path: { projectId, path } },
      select: { ...METADATA, content: true },
    });
  }

  listSubtree(projectId: string, directory: string): Promise<FileRecord[]> {
    return this.db.projectFile.findMany({
      where: {
        projectId,
        OR: [{ path: directory }, { path: { startsWith: `${directory}/` } }],
      },
      select: METADATA,
      orderBy: { path: 'asc' },
    });
  }

  createDirectory(projectId: string, path: string, parentPath: string, name: string) {
    return this.db.projectFile.create({
      data: { projectId, path, parentPath, name, type: 'DIRECTORY', size: 0 },
      select: METADATA,
    });
  }

  async write(input: WriteFileInput): Promise<FileRecord> {
    return this.db.projectFile.upsert({
      where: { projectId_path: { projectId: input.projectId, path: input.path } },
      create: {
        projectId: input.projectId,
        path: input.path,
        parentPath: input.parentPath,
        name: input.name,
        type: 'FILE',
        content: Buffer.from(input.content),
        size: input.size,
        checksum: input.checksum,
        isBinary: input.isBinary,
      },
      update: {
        content: Buffer.from(input.content),
        size: input.size,
        checksum: input.checksum,
        isBinary: input.isBinary,
        version: { increment: 1 },
      },
      select: METADATA,
    });
  }

  async writeIfVersion(input: WriteFileInput, expectedVersion: number): Promise<FileRecord | null> {
    const result = await this.db.projectFile.updateMany({
      where: { projectId: input.projectId, path: input.path, version: expectedVersion },
      data: {
        content: Buffer.from(input.content),
        size: input.size,
        checksum: input.checksum,
        isBinary: input.isBinary,
        version: { increment: 1 },
      },
    });

    if (result.count === 0) return null;
    return this.findByPath(input.projectId, input.path);
  }

  async deleteSubtree(projectId: string, path: string): Promise<number> {
    const result = await this.db.projectFile.deleteMany({
      where: { projectId, OR: [{ path }, { path: { startsWith: `${path}/` } }] },
    });
    return result.count;
  }

  async deleteAllForProject(projectId: string): Promise<number> {
    const result = await this.db.projectFile.deleteMany({ where: { projectId } });
    return result.count;
  }

  async updatePath(id: string, path: string, parentPath: string, name: string): Promise<void> {
    await this.db.projectFile.update({ where: { id }, data: { path, parentPath, name } });
  }

  transaction<T>(work: (repository: FileRepository) => Promise<T>): Promise<T> {
    return this.db.$transaction((tx) => work(new FileRepository(tx as unknown as Database)));
  }

  countForProject(projectId: string): Promise<number> {
    return this.db.projectFile.count({ where: { projectId } });
  }

  async totalBytes(projectId: string): Promise<number> {
    const result = await this.db.projectFile.aggregate({
      where: { projectId },
      _sum: { size: true },
    });
    return result._sum.size ?? 0;
  }

  searchByPath(projectId: string, query: string, limit: number): Promise<FileRecord[]> {
    return this.db.projectFile.findMany({
      where: { projectId, type: 'FILE', path: { contains: query, mode: 'insensitive' } },
      select: METADATA,
      orderBy: { path: 'asc' },
      take: limit,
    });
  }

  listTextFilesForScan(
    projectId: string,
    maxFiles: number,
    maxFileBytes: number,
  ): Promise<{ path: string; content: Uint8Array | null }[]> {
    return this.db.projectFile.findMany({
      where: {
        projectId,
        type: 'FILE',
        isBinary: false,
        size: { lte: maxFileBytes, gt: 0 },
      },
      select: { path: true, content: true },
      orderBy: { path: 'asc' },
      take: maxFiles,
    });
  }
}
