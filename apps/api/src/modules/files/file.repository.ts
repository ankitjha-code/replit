import type { ProjectFileType } from '@platform/shared';
import type { Database } from '../../db/client.js';

/**
 * The only code that reads or writes the project_files table.
 *
 * Path validation, size limits and type rules belong to the service. This
 * layer stores what it is given and answers questions about what is stored.
 */

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

/** Columns needed to describe a file without reading its content. */
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

  /**
   * Every entry in a project, without content.
   *
   * Content is excluded deliberately: a tree of a hundred files would
   * otherwise transfer every byte of every one of them to draw a sidebar.
   */
  listAll(projectId: string): Promise<FileRecord[]> {
    return this.db.projectFile.findMany({
      where: { projectId },
      select: METADATA,
      orderBy: { path: 'asc' },
    });
  }

  /**
   * Every entry in a project, with content.
   *
   * Used to copy a project into a runtime. Bounded by the per-project size
   * ceiling, which is what keeps this from being an unbounded read: without
   * that limit this method would be a way to ask the server to hold an
   * arbitrary amount of memory.
   */
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

  /** Every entry at or under a directory, including the directory itself. */
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

  /**
   * Writes a file, creating it or replacing its content.
   *
   * The version increments on every write, so a reader that saw version 3 can
   * tell that what it is about to overwrite is no longer version 3.
   */
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

  /**
   * Writes only if the stored version still matches.
   *
   * A conditional update rather than a read followed by a write: the database
   * decides, so two saves racing cannot both believe they won.
   */
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

  /**
   * Empties a project of every file and folder.
   *
   * Only ever called inside a transaction that writes the replacement in the
   * same breath: on its own this is the destruction of a project's source, and
   * no route reaches it directly.
   */
  async deleteAllForProject(projectId: string): Promise<number> {
    const result = await this.db.projectFile.deleteMany({ where: { projectId } });
    return result.count;
  }

  /**
   * Rewrites the path of one entry.
   *
   * Moving a directory means rewriting every descendant, which the service
   * does inside one transaction using this.
   */
  async updatePath(id: string, path: string, parentPath: string, name: string): Promise<void> {
    await this.db.projectFile.update({ where: { id }, data: { path, parentPath, name } });
  }

  /** Runs a set of writes atomically, so a partial move cannot be observed. */
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

  /** Path and name matches, cheap and safe for every file including binaries. */
  searchByPath(projectId: string, query: string, limit: number): Promise<FileRecord[]> {
    return this.db.projectFile.findMany({
      where: { projectId, type: 'FILE', path: { contains: query, mode: 'insensitive' } },
      select: METADATA,
      orderBy: { path: 'asc' },
      take: limit,
    });
  }

  /**
   * Text files small enough to scan, for content search.
   *
   * The scan itself happens in the service rather than in SQL. A database
   * full-text index would be faster on a large corpus, but it answers a
   * different question: it matches words, and someone searching code wants
   * substrings, including punctuation. Reading a project's text files and
   * scanning them is the honest implementation at this size, and the caps
   * below bound what it can cost.
   *
   * Binaries are excluded because decoding them as text is meaningless, and
   * anything over the byte cap is excluded because one large generated file
   * should not dominate every search.
   */
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
