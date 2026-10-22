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

/**
 * One entry on its way out of the database and into a filesystem.
 *
 * Deliberately not the execution plane's own type: the file service knows
 * nothing about runtimes, and a shared shape between the two would tie them
 * together for no gain.
 */
export interface ProjectFileExport {
  path: string;
  /** Null for a directory. */
  content: Uint8Array | null;
}

/**
 * Project files.
 *
 * Every rule about what a project's filesystem may contain lives here: path
 * validity, size and count ceilings, what may overwrite what. The repository
 * below stores bytes; the authorization guard above decides who may ask.
 *
 * The most important rule is that a path is validated once, on the way in, and
 * what is stored is the normalised result. A path that reached the table
 * unvalidated would become a path written into a container filesystem in a
 * later task, and a traversal here would be a container escape there.
 */

export interface FileServiceOptions {
  /** Largest single file, in bytes. */
  maxFileBytes: number;
  /** Largest total across a project, in bytes. */
  maxProjectBytes: number;
  /** Most entries one project may hold. */
  maxEntries: number;
  /** Largest file the content search will read. */
  maxSearchFileBytes: number;
  /** Most files the content search will read. */
  maxSearchFiles: number;
  /** Most results a search returns. */
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

/** How a whole-project replacement turned out. */
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

  /**
   * Where changes are announced, once there is anywhere to announce them.
   *
   * Optional and set after construction, following the pattern the runtime
   * service already uses: a file service built for a unit test has nobody
   * listening, and should not have to be handed a bus to say so.
   */
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

  /**
   * The whole project, ready to be written into a filesystem.
   *
   * Directories are included with null content, so an empty folder someone
   * created survives the copy. The order is by path, which puts a directory
   * before everything inside it.
   */
  async exportAll(projectId: string): Promise<ProjectFileExport[]> {
    const records = await this.files.listAllWithContent(projectId);
    return records.map((record) => ({
      path: record.path,
      content: record.type === 'DIRECTORY' ? null : (record.content ?? new Uint8Array()),
    }));
  }

  /**
   * Replaces the project's files with what a runtime came back with.
   *
   * The container is where the work just happened, so for the paths it covers
   * it wins outright. Nothing is merged: a three-way merge needs a common
   * ancestor, and there is none between a file someone edited in the browser
   * and the same file rewritten by a formatter.
   *
   * What the container does not cover is left alone. Paths excluded from a
   * sync are never deleted for being absent, because they were never looked
   * at, and deleting a file on the strength of not having read it is how a
   * sync destroys a project.
   *
   * All or nothing. A sync that would breach a limit is refused whole rather
   * than applied in part, because a project half-updated by a build is worse
   * than one not updated at all.
   */
  async applyFromRuntime(
    projectId: string,
    incoming: readonly { path: string; content: Uint8Array }[],
  ): Promise<WorkspaceSyncResult> {
    const existing = await this.files.listAll(projectId);

    /*
     * An empty read never empties a project.
     *
     * A container that reports no files is far more likely to be a read that
     * went wrong than a person who deleted everything and wants that recorded.
     * The cost of being wrong in one direction is a sync that did nothing; in
     * the other it is the whole project. Someone who genuinely means it can
     * delete files in the explorer, where it takes a confirmation.
     */
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
        // A path from a container is input: it was produced by code the
        // platform did not write.
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
        // The container has a file where the project has a folder. Refusing
        // one path is better than deleting a subtree nobody asked about.
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

    // Only when something actually moved. A sync that found nothing to do is
    // not news, and telling every open window about it would make a periodic
    // read-back look like activity.
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

  /**
   * Replaces every file in the project with the set given.
   *
   * This is what a restore is made of, and it is the most destructive operation
   * the file service has: what the project held and the replacement does not is
   * gone, including paths a sync would have left alone. That is the difference
   * between restoring and syncing. A sync reads back a filesystem that is a
   * partial view of the project and so must never delete on the strength of an
   * absence; a restore is somebody saying "make it be this", where an absence
   * is the whole point.
   *
   * The protections that remain are the ones that are still meaningful. Every
   * path is validated, because these bytes come from an archive that may be old
   * and may have been elsewhere in between. Every limit is checked before
   * anything is written, so a restore that will not fit is refused whole rather
   * than applied halfway. And it happens in one transaction, so there is no
   * moment at which a reader sees a project that is neither version.
   *
   * The caller is responsible for the thing that makes this survivable: a
   * snapshot of what was there first. See RestoreService.
   */
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

      // The same path twice is an archive that cannot be materialised: a
      // filesystem has one thing at each name. Refused rather than resolved by
      // arrival order, which would make the result depend on the order.
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
      /*
       * Everything out, then everything in, inside one transaction.
       *
       * Emptying first is what makes the result exactly the set given rather
       * than a merge with whatever was there. It is also why this has to be
       * transactional: outside one, a failure between the two halves would
       * leave an empty project, which is the single worst outcome available.
       */
      await repository.deleteAllForProject(projectId);

      // Shortest first, so a directory is created before its children and
      // nothing has to be created twice.
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

  /**
   * Validates a path arriving from an archive rather than from a request.
   *
   * Separate from the path check every route uses only in what it says when it
   * fails: "that path is not valid" is useless when the caller did not type the
   * path, so this one names the offender and says where it came from.
   */
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

  /**
   * Refuses a replacement that would not fit, before anything is written.
   *
   * Unlike a sync, the arithmetic here does not have to account for what
   * survives: nothing does. The replacement is the whole project, so its own
   * size is the project's size.
   */
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
      // Binary content is base64 rather than mangled into replacement
      // characters. A caller that cannot display it can at least keep it.
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
        // They believed they were replacing something that is not there.
        throw conflict('That file no longer exists');
      }

      // The file already exists, so its ancestors do too.
      const updated = await this.files.writeIfVersion(write, input.expectedVersion);
      if (!updated) {
        throw new AppError('CONFLICT', 'This file changed since you opened it', {
          details: { path, currentVersion: existing.version },
        });
      }
      this.events?.publish(projectId, { type: 'file.written', path });
      return toEntry(updated);
    }

    // One transaction, so a failure cannot leave directories behind with no
    // file inside them.
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

    // A folder is a change to the tree, so it travels as one. There is no
    // separate event for it: a client redraws the tree either way.
    this.events?.publish(projectId, { type: 'file.written', path });
    return toEntry(record);
  }

  /**
   * Moves or renames a path, and everything under it.
   *
   * Renaming and moving are the same operation: both change a path. Treating
   * them separately would mean two code paths with the same subtree rewrite in
   * each.
   */
  async move(projectId: string, rawFrom: string, rawTo: string): Promise<FileEntry> {
    const from = this.requireValidPath(rawFrom, 'from');
    const to = this.requireValidPath(rawTo, 'to');

    if (from === to) {
      throw new AppError('BAD_REQUEST', 'The source and destination are the same');
    }

    // Moving a directory inside itself would orphan the subtree: the rewritten
    // descendants would sit under a path that no longer exists.
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
        // Every descendant keeps its position relative to the moved root.
        const suffix = record.path.slice(from.length);
        const nextPath = `${to}${suffix}`;
        await repository.updatePath(record.id, nextPath, parentOf(nextPath), baseName(nextPath));
      }

      const record = await repository.findByPath(projectId, to);
      if (!record) throw new Error(`move left nothing at ${to}`);

      this.log.info({ projectId, from, to, entries: subtree.length }, 'path moved');
      return toEntry(record);
    });

    // Announced after the transaction commits, not inside it. An event about a
    // move that then rolled back would send every open window looking for a
    // file that is still where it was.
    this.events?.publish(projectId, { type: 'file.moved', from, to });
    return moved;
  }

  /** Removes a path and, when it is a directory, everything under it. */
  async remove(projectId: string, rawPath: string): Promise<{ removed: number }> {
    const path = this.requireValidPath(rawPath);

    const record = await this.files.findByPath(projectId, path);
    if (!record) throw notFound();

    const removed = await this.files.deleteSubtree(projectId, path);
    this.log.info({ projectId, path, removed }, 'path removed');
    this.events?.publish(projectId, { type: 'file.removed', path });
    return { removed };
  }

  /**
   * Finds files by path and by content.
   *
   * Path matches come first: someone searching for "server" usually wants
   * server.ts, not every line that mentions the word.
   */
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

  // -------------------------------------------------------------------------

  /**
   * Validates a path and returns its normalised form.
   *
   * The single gate. Every public method above starts here, so no path reaches
   * the repository without having passed.
   */
  /**
   * Refuses a sync that would leave the project over a limit.
   *
   * Checked before anything is written rather than as each file lands, so the
   * answer is the same whichever order the files arrived in.
   */
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
      // A rewritten file replaces its old size rather than adding to it.
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

  /**
   * Creates any missing ancestor directories, as `mkdir -p` would.
   *
   * Directories are explicit rows, so writing `src/a.ts` into an empty project
   * has to create `src` as well. Leaving it implicit would give the explorer a
   * folder with no entry behind it: visible in the tree, impossible to rename
   * or delete, and absent from any listing.
   *
   * An ancestor that is a file is refused. A project could otherwise hold both
   * `notes.txt` and `notes.txt/a.js`, which is representable in a table of
   * paths and impossible on any real filesystem, and would fail only when the
   * project was materialised into a container.
   */
  private async ensureAncestorDirectories(
    repository: FileRepository,
    projectId: string,
    path: string,
  ): Promise<number> {
    // Nearest first, so the file check below reports the closest offender.
    const ancestors: string[] = [];
    for (let parent = parentOf(path); parent !== ROOT_PATH; parent = parentOf(parent)) {
      ancestors.push(parent);
    }

    let created = 0;

    // Outermost first, so a directory is never created before its own parent.
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

// ---------------------------------------------------------------------------

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

/**
 * Whether bytes are valid UTF-8.
 *
 * Decoding and re-encoding is the reliable test: a lenient decoder replaces
 * every invalid sequence with U+FFFD, so the round trip differs exactly when
 * something was lost.
 */
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
      // Trimmed and bounded: a minified file is one line of half a megabyte,
      // and returning it would be useless and expensive.
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
