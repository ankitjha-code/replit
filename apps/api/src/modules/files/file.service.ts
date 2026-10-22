import { createHash } from 'node:crypto';
import {
  isExcludedFromSync,
  type BulkFileReason,
  MAX_REPORTED_SKIPS,
  PATH_PROBLEM_MESSAGES,
  ROOT_PATH,
  baseName,
  isInside,
  normalizePath,
  parentOf,
  type FileEntry,
  type SearchResult,
  type SyncSkipReason,
  type WorkspaceSyncResult,
} from '@platform/shared';
import type { Logger } from 'pino';
import { AppError } from '../../errors/app-error.js';
import type { ProjectEventPublisher } from '../../events/project-event-bus.js';
import type { FileRecord, FileRepository, WriteFileInput } from './file.repository.js';

export interface ProjectFileExport {
  path: string;
  content: Uint8Array | null;
}

export interface FileServiceOptions {
  maxFileBytes: number;
  maxProjectBytes: number;
  maxEntries: number;
  maxSearchFileBytes: number;
  maxSearchFiles: number;
  maxSearchResults: number;
}

export const DEFAULT_FILE_OPTIONS: FileServiceOptions = {
  maxFileBytes: 1024 * 1024,
  maxProjectBytes: 64 * 1024 * 1024,
  maxEntries: 5_000,
  maxSearchFileBytes: 256 * 1024,
  maxSearchFiles: 2_000,
  maxSearchResults: 100,
};

export interface ReplaceAllResult {
  created: number;
  updated: number;
  deleted: number;
  unchanged: number;
}

export interface FileContent {
  entry: FileEntry;
  content: string;
  encoding: 'utf8' | 'base64';
}

export class FileService {
  constructor(
    private readonly files: FileRepository,
    private readonly options: FileServiceOptions,
    private readonly log: Logger,
  ) {}

  private events: ProjectEventPublisher | undefined;

  useEvents(events: ProjectEventPublisher): void {
    this.events = events;
  }

  async listTree(projectId: string): Promise<{ entries: FileEntry[]; totalBytes: number }> {
    const records = await this.files.listAll(projectId);
    return {
      entries: records.map(toEntry),
      totalBytes: records.reduce((total, record) => total + record.size, 0),
    };
  }

  async exportAll(projectId: string): Promise<ProjectFileExport[]> {
    const records = await this.files.listAllWithContent(projectId);
    return records.map((record) => ({
      path: record.path,
      content: record.type === 'DIRECTORY' ? null : (record.content ?? new Uint8Array()),
    }));
  }

  async applyFromRuntime(
    projectId: string,
    incoming: readonly { path: string; content: Uint8Array }[],
  ): Promise<WorkspaceSyncResult> {
    const existing = await this.files.listAll(projectId);

    if (incoming.length === 0 && existing.length > 0) {
      this.log.warn({ projectId }, 'runtime reported an empty workspace; nothing was applied');
      return {
        created: 0,
        updated: 0,
        deleted: 0,
        unchanged: 0,
        skipped: [{ path: '', reason: 'empty-read' }],
        skippedTruncated: false,
      };
    }

    const existingByPath = new Map(existing.map((record) => [record.path, record]));

    const skipped: { path: string; reason: SyncSkipReason }[] = [];
    const writes: WriteFileInput[] = [];
    const seen = new Set<string>();
    let unchanged = 0;
    let created = 0;

    for (const file of incoming) {
      let path: string;
      try {
        path = this.requireValidPath(file.path);
      } catch {
        skipped.push({ path: file.path, reason: 'invalid-path' });
        continue;
      }

      if (isExcludedFromSync(path)) {
        skipped.push({ path, reason: 'excluded' });
        continue;
      }

      const bytes = Buffer.from(file.content);

      if (bytes.byteLength > this.options.maxFileBytes) {
        skipped.push({ path, reason: 'too-large' });
        continue;
      }

      seen.add(path);
      const current = existingByPath.get(path);

      if (current?.type === 'DIRECTORY') {
        skipped.push({ path, reason: 'invalid-path' });
        continue;
      }

      const checksum = createHash('sha256').update(bytes).digest('hex');
      if (current && current.checksum === checksum) {
        unchanged += 1;
        continue;
      }

      if (!current) created += 1;

      writes.push({
        projectId,
        path,
        parentPath: parentOf(path),
        name: baseName(path),
        content: bytes,
        size: bytes.byteLength,
        checksum,
        isBinary: !isValidUtf8(bytes),
      });
    }

    const removals = existing
      .filter((record) => record.type === 'FILE')
      .filter((record) => !seen.has(record.path))
      .filter((record) => !isExcludedFromSync(record.path))
      .map((record) => record.path);

    await this.assertSyncFits(existing, writes, removals);

    if (writes.length > 0 || removals.length > 0) {
      await this.files.transaction(async (repository) => {
        for (const path of removals) {
          await repository.deleteSubtree(projectId, path);
        }
        for (const write of writes) {
          await this.ensureAncestorDirectories(repository, projectId, write.path);
          await repository.write(write);
        }
      });
    }

    this.log.info(
      { projectId, created, updated: writes.length - created, deleted: removals.length },
      'workspace synced from runtime',
    );

    if (writes.length > 0 || removals.length > 0) {
      this.events?.publish(projectId, {
        type: 'files.replaced',
        reason: 'runtime-sync',
        created,
        updated: writes.length - created,
        deleted: removals.length,
      });
    }

    return {
      created,
      updated: writes.length - created,
      deleted: removals.length,
      unchanged,
      skipped: skipped.slice(0, MAX_REPORTED_SKIPS),
      skippedTruncated: skipped.length > MAX_REPORTED_SKIPS,
    };
  }

  async replaceAll(
    projectId: string,
    incoming: readonly ProjectFileExport[],
    reason: BulkFileReason,
  ): Promise<ReplaceAllResult> {
    const existing = await this.files.listAll(projectId);
    const existingByPath = new Map(existing.map((record) => [record.path, record]));

    const directories: string[] = [];
    const writes: WriteFileInput[] = [];
    const seen = new Set<string>();

    let created = 0;
    let updated = 0;
    let unchanged = 0;

    for (const entry of incoming) {
      const path = this.requireRestorablePath(entry.path);

      if (seen.has(path)) {
        throw new AppError('BAD_REQUEST', `That version contains "${path}" more than once.`, {
          expose: true,
        });
      }
      seen.add(path);

      const current = existingByPath.get(path);

      if (entry.content === null) {
        directories.push(path);
        if (!current) created += 1;
        else if (current.type === 'DIRECTORY') unchanged += 1;
        else updated += 1;
        continue;
      }

      const bytes = Buffer.from(entry.content);

      if (bytes.byteLength > this.options.maxFileBytes) {
        throw tooLarge(
          `"${path}" is larger than the ${formatBytes(this.options.maxFileBytes)} limit this installation allows.`,
        );
      }

      const checksum = createHash('sha256').update(bytes).digest('hex');

      if (!current) created += 1;
      else if (current.type === 'FILE' && current.checksum === checksum) unchanged += 1;
      else updated += 1;

      writes.push({
        projectId,
        path,
        parentPath: parentOf(path),
        name: baseName(path),
        content: bytes,
        size: bytes.byteLength,
        checksum,
        isBinary: !isValidUtf8(bytes),
      });
    }

    const deleted = existing.filter((record) => !seen.has(record.path)).length;

    this.assertReplacementFits(writes, directories.length);

    await this.files.transaction(async (repository) => {
      await repository.deleteAllForProject(projectId);

      for (const path of [...directories].sort((a, b) => a.length - b.length)) {
        await this.ensureAncestorDirectories(repository, projectId, path);
        await repository.createDirectory(projectId, path, parentOf(path), baseName(path));
      }

      for (const write of writes) {
        await this.ensureAncestorDirectories(repository, projectId, write.path);
        await repository.write(write);
      }
    });

    this.log.info(
      { projectId, reason, created, updated, deleted, unchanged },
      'project files replaced',
    );

    this.events?.publish(projectId, { type: 'files.replaced', reason, created, updated, deleted });

    return { created, updated, deleted, unchanged };
  }

  private requireRestorablePath(input: string): string {
    const result = normalizePath(input);
    if (!result.ok || !result.path) {
      throw new AppError(
        'BAD_REQUEST',
        `That version contains a path this platform cannot write: "${input}".`,
        { expose: true, context: { path: input, problem: result.problem ?? 'empty' } },
      );
    }
    return result.path;
  }

  private assertReplacementFits(writes: readonly WriteFileInput[], directories: number): void {
    const bytes = writes.reduce((total, write) => total + write.size, 0);

    if (bytes > this.options.maxProjectBytes) {
      throw tooLarge(
        `That version is larger than the ${formatBytes(this.options.maxProjectBytes)} a project may hold on this installation.`,
      );
    }

    const count = writes.length + directories;
    if (count > this.options.maxEntries) {
      throw new AppError(
        'PAYLOAD_TOO_LARGE',
        `That version holds ${count} files and folders, past this installation's limit of ${this.options.maxEntries}.`,
        { details: { limit: this.options.maxEntries } },
      );
    }
  }

  async read(projectId: string, rawPath: string): Promise<FileContent> {
    const path = this.requireValidPath(rawPath);
    const record = await this.files.findWithContent(projectId, path);

    if (!record) throw notFound();
    if (record.type === 'DIRECTORY') {
      throw new AppError('BAD_REQUEST', 'That path is a directory, not a file');
    }

    const bytes = Buffer.from(record.content ?? new Uint8Array());
    return {
      entry: toEntry(record),
      content: record.isBinary ? bytes.toString('base64') : bytes.toString('utf8'),
      encoding: record.isBinary ? 'base64' : 'utf8',
    };
  }

  async write(
    projectId: string,
    input: { path: string; content: string; encoding: 'utf8' | 'base64'; expectedVersion?: number },
  ): Promise<FileEntry> {
    const path = this.requireValidPath(input.path);
    const bytes = decode(input.content, input.encoding);

    if (bytes.byteLength > this.options.maxFileBytes) {
      throw tooLarge(
        `That file is larger than the ${formatBytes(this.options.maxFileBytes)} limit`,
      );
    }

    const existing = await this.files.findByPath(projectId, path);
    if (existing?.type === 'DIRECTORY') {
      throw new AppError('CONFLICT', 'A directory already exists at that path');
    }

    await this.assertRoomFor(projectId, bytes.byteLength, existing);

    const write = {
      projectId,
      path,
      parentPath: parentOf(path),
      name: baseName(path),
      content: bytes,
      size: bytes.byteLength,
      checksum: createHash('sha256').update(bytes).digest('hex'),
      isBinary: !isValidUtf8(bytes),
    };

    if (input.expectedVersion !== undefined) {
      if (!existing) {
        throw conflict('That file no longer exists');
      }

      const updated = await this.files.writeIfVersion(write, input.expectedVersion);
      if (!updated) {
        throw new AppError('CONFLICT', 'This file changed since you opened it', {
          details: { path, currentVersion: existing.version },
        });
      }
      this.events?.publish(projectId, { type: 'file.written', path });
      return toEntry(updated);
    }

    const record = await this.files.transaction(async (repository) => {
      await this.ensureAncestorDirectories(repository, projectId, path);
      return repository.write(write);
    });

    this.log.debug({ projectId, path, size: write.size }, 'file written');
    this.events?.publish(projectId, { type: 'file.written', path });
    return toEntry(record);
  }

  async createDirectory(projectId: string, rawPath: string): Promise<FileEntry> {
    const path = this.requireValidPath(rawPath);

    const existing = await this.files.findByPath(projectId, path);
    if (existing) {
      throw conflict(
        existing.type === 'DIRECTORY'
          ? 'That directory already exists'
          : 'A file already exists at that path',
      );
    }

    await this.assertRoomForEntries(projectId, 1);

    const record = await this.files.transaction(async (repository) => {
      await this.ensureAncestorDirectories(repository, projectId, path);
      return repository.createDirectory(projectId, path, parentOf(path), baseName(path));
    });

    this.events?.publish(projectId, { type: 'file.written', path });
    return toEntry(record);
  }

  async move(projectId: string, rawFrom: string, rawTo: string): Promise<FileEntry> {
    const from = this.requireValidPath(rawFrom, 'from');
    const to = this.requireValidPath(rawTo, 'to');

    if (from === to) {
      throw new AppError('BAD_REQUEST', 'The source and destination are the same');
    }

    if (isInside(from, to)) {
      throw new AppError('BAD_REQUEST', 'A directory cannot be moved inside itself');
    }

    const source = await this.files.findByPath(projectId, from);
    if (!source) throw notFound();

    const destination = await this.files.findByPath(projectId, to);
    if (destination) throw conflict('Something already exists at the destination');

    const moved = await this.files.transaction(async (repository) => {
      await this.ensureAncestorDirectories(repository, projectId, to);

      const subtree =
        source.type === 'DIRECTORY'
          ? await repository.listSubtree(projectId, from)
          : [await repository.findByPath(projectId, from)].filter(isPresent);

      for (const record of subtree) {
        const suffix = record.path.slice(from.length);
        const nextPath = `${to}${suffix}`;
        await repository.updatePath(record.id, nextPath, parentOf(nextPath), baseName(nextPath));
      }

      const record = await repository.findByPath(projectId, to);
      if (!record) throw new Error(`move left nothing at ${to}`);

      this.log.info({ projectId, from, to, entries: subtree.length }, 'path moved');
      return toEntry(record);
    });

    this.events?.publish(projectId, { type: 'file.moved', from, to });
    return moved;
  }

  async remove(projectId: string, rawPath: string): Promise<{ removed: number }> {
    const path = this.requireValidPath(rawPath);

    const record = await this.files.findByPath(projectId, path);
    if (!record) throw notFound();

    const removed = await this.files.deleteSubtree(projectId, path);
    this.log.info({ projectId, path, removed }, 'path removed');
    this.events?.publish(projectId, { type: 'file.removed', path });
    return { removed };
  }

  async search(
    projectId: string,
    query: string,
  ): Promise<{ results: SearchResult[]; truncated: boolean }> {
    const trimmed = query.trim();
    if (trimmed.length === 0) return { results: [], truncated: false };

    const limit = this.options.maxSearchResults;
    const results: SearchResult[] = [];
    const seen = new Set<string>();

    for (const record of await this.files.searchByPath(projectId, trimmed, limit)) {
      results.push({ path: record.path, match: 'path' });
      seen.add(record.path);
    }

    const needle = trimmed.toLowerCase();
    const candidates = await this.files.listTextFilesForScan(
      projectId,
      this.options.maxSearchFiles,
      this.options.maxSearchFileBytes,
    );

    let truncated = false;

    for (const candidate of candidates) {
      if (results.length >= limit) {
        truncated = true;
        break;
      }
      if (seen.has(candidate.path) || !candidate.content) continue;

      const hit = firstMatchingLine(Buffer.from(candidate.content).toString('utf8'), needle);
      if (hit) {
        results.push({
          path: candidate.path,
          match: 'content',
          line: hit.line,
          lineNumber: hit.lineNumber,
        });
      }
    }

    return { results: results.slice(0, limit), truncated: truncated || results.length > limit };
  }

  private async assertSyncFits(
    existing: readonly FileRecord[],
    writes: readonly WriteFileInput[],
    removals: readonly string[],
  ): Promise<void> {
    const existingByPath = new Map(existing.map((record) => [record.path, record]));
    const removed = new Set(removals);

    let bytes = 0;
    let count = 0;

    for (const record of existing) {
      if (removed.has(record.path)) continue;
      bytes += record.size;
      count += 1;
    }

    for (const write of writes) {
      const current = existingByPath.get(write.path);
      if (current && !removed.has(write.path)) bytes -= current.size;
      else count += 1;
      bytes += write.size;
    }

    if (bytes > this.options.maxProjectBytes) {
      throw tooLarge(
        `Reading this environment back would take the project past its ${formatBytes(this.options.maxProjectBytes)} limit. Remove what does not belong in it, then try again.`,
      );
    }

    if (count > this.options.maxEntries) {
      throw new AppError(
        'PAYLOAD_TOO_LARGE',
        `Reading this environment back would take the project past its limit of ${this.options.maxEntries} files and folders.`,
        { details: { limit: this.options.maxEntries } },
      );
    }

    return Promise.resolve();
  }

  private requireValidPath(input: string, field = 'path'): string {
    const result = normalizePath(input);
    if (!result.ok || !result.path) {
      throw new AppError('VALIDATION_FAILED', 'That path is not valid', {
        details: {
          fields: [{ path: field, message: PATH_PROBLEM_MESSAGES[result.problem ?? 'empty'] }],
        },
      });
    }
    return result.path;
  }

  private async ensureAncestorDirectories(
    repository: FileRepository,
    projectId: string,
    path: string,
  ): Promise<number> {
    const ancestors: string[] = [];
    for (let parent = parentOf(path); parent !== ROOT_PATH; parent = parentOf(parent)) {
      ancestors.push(parent);
    }

    let created = 0;

    for (const ancestor of ancestors.reverse()) {
      const record = await repository.findByPath(projectId, ancestor);

      if (record?.type === 'FILE') {
        throw conflict(`"${ancestor}" is a file, so nothing can be created inside it`);
      }
      if (record) continue;

      await repository.createDirectory(projectId, ancestor, parentOf(ancestor), baseName(ancestor));
      created += 1;
    }

    return created;
  }

  private async assertRoomFor(
    projectId: string,
    incomingBytes: number,
    replacing: FileRecord | null,
  ): Promise<void> {
    if (!replacing) await this.assertRoomForEntries(projectId, 1);

    const current = await this.files.totalBytes(projectId);
    const projected = current - (replacing?.size ?? 0) + incomingBytes;

    if (projected > this.options.maxProjectBytes) {
      throw tooLarge(
        `This project would exceed its ${formatBytes(this.options.maxProjectBytes)} limit`,
      );
    }
  }

  private async assertRoomForEntries(projectId: string, adding: number): Promise<void> {
    const count = await this.files.countForProject(projectId);
    if (count + adding > this.options.maxEntries) {
      throw new AppError(
        'CONFLICT',
        `This project has reached its limit of ${this.options.maxEntries} files and folders`,
        { details: { limit: this.options.maxEntries } },
      );
    }
  }
}

function toEntry(record: FileRecord): FileEntry {
  return {
    path: record.path,
    name: record.name,
    type: record.type,
    size: record.size,
    isBinary: record.isBinary,
    version: record.version,
    updatedAt: record.updatedAt.toISOString(),
  };
}

function decode(content: string, encoding: 'utf8' | 'base64'): Buffer {
  return Buffer.from(content, encoding === 'base64' ? 'base64' : 'utf8');
}

function isValidUtf8(bytes: Buffer): boolean {
  const decoded = bytes.toString('utf8');
  return Buffer.from(decoded, 'utf8').equals(bytes);
}

function firstMatchingLine(
  text: string,
  needle: string,
): { line: string; lineNumber: number } | undefined {
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.toLowerCase().includes(needle)) {
      return { line: line.trim().slice(0, 200), lineNumber: index + 1 };
    }
  }
  return undefined;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

function isPresent<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}

const notFound = (): AppError => new AppError('NOT_FOUND', 'That file does not exist');
const conflict = (message: string): AppError => new AppError('CONFLICT', message);
const tooLarge = (message: string): AppError => new AppError('PAYLOAD_TOO_LARGE', message);
