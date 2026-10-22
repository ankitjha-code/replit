import type { LogSource, LogStream } from '@platform/shared';
import type { Database } from '../../db/client.js';

/**
 * The only code that reads or writes the project_log_lines table.
 *
 * Written in batches and read backwards, which is the shape of every log
 * anybody has ever kept: output arrives faster than anything reads it, and
 * reading starts at the end.
 */

export interface LogRecord {
  id: string;
  source: LogSource;
  sourceId: string;
  stream: string;
  message: string;
  at: Date;
}

export interface LogWrite {
  projectId: string;
  source: LogSource;
  sourceId: string;
  stream: LogStream;
  message: string;
  at: Date;
}

export interface LogFilter {
  source?: LogSource | undefined;
  sourceId?: string | undefined;
  stream?: LogStream | undefined;
  /** Only lines older than this identifier, for paging backwards. */
  before?: string | undefined;
  /** Only lines whose text contains this, ignoring case. */
  contains?: string | undefined;
  limit: number;
}

const FIELDS = {
  id: true,
  source: true,
  sourceId: true,
  stream: true,
  message: true,
  at: true,
} as const;

export class LogRepository {
  constructor(private readonly db: Database) {}

  /**
   * Writes many lines at once.
   *
   * One statement per flush rather than one per line. A program printing a
   * thousand lines a second is ordinary, and a round trip each would make the
   * log the most expensive thing about running anything.
   */
  async append(lines: readonly LogWrite[]): Promise<void> {
    if (lines.length === 0) return;
    await this.db.projectLogLine.createMany({ data: [...lines] });
  }

  /**
   * A page of a project's log, newest first.
   *
   * Newest first because that is what the index is ordered for and what paging
   * backwards needs; the service reverses it, because that is how a log is read.
   */
  async page(projectId: string, filter: LogFilter): Promise<LogRecord[]> {
    const before = filter.before
      ? await this.db.projectLogLine.findFirst({
          where: { id: filter.before, projectId },
          select: { at: true, id: true },
        })
      : null;

    return this.db.projectLogLine.findMany({
      where: {
        projectId,
        ...(filter.source ? { source: filter.source } : {}),
        ...(filter.sourceId ? { sourceId: filter.sourceId } : {}),
        ...(filter.stream ? { stream: filter.stream } : {}),
        ...(filter.contains
          ? { message: { contains: filter.contains, mode: 'insensitive' as const } }
          : {}),
        /*
         * Strictly older than the cursor, by time and then by identifier.
         *
         * Two lines can share a millisecond, so time alone would either repeat
         * one across two pages or skip one between them. The identifiers are
         * time-ordered, which is what makes the tie-break meaningful.
         */
        ...(before
          ? {
              OR: [{ at: { lt: before.at } }, { at: before.at, id: { lt: before.id } }],
            }
          : {}),
      },
      orderBy: [{ at: 'desc' }, { id: 'desc' }],
      take: filter.limit,
      select: FIELDS,
    });
  }

  /**
   * Lines strictly newer than a cursor, oldest first — the live tail.
   *
   * A cursor that no longer exists (pruned) answers with the newest lines rather
   * than nothing, so a page that fell behind catches up instead of going quiet.
   */
  async after(projectId: string, filter: LogFilter & { after: string }): Promise<LogRecord[]> {
    const cursor = await this.db.projectLogLine.findFirst({
      where: { id: filter.after, projectId },
      select: { at: true, id: true },
    });

    const where = {
      projectId,
      ...(filter.source ? { source: filter.source } : {}),
      ...(filter.sourceId ? { sourceId: filter.sourceId } : {}),
      ...(filter.stream ? { stream: filter.stream } : {}),
      ...(filter.contains
        ? { message: { contains: filter.contains, mode: 'insensitive' as const } }
        : {}),
    };

    if (!cursor) {
      const newest = await this.db.projectLogLine.findMany({
        where,
        orderBy: [{ at: 'desc' }, { id: 'desc' }],
        take: filter.limit,
        select: FIELDS,
      });
      return newest.reverse();
    }

    return this.db.projectLogLine.findMany({
      where: {
        ...where,
        OR: [{ at: { gt: cursor.at } }, { at: cursor.at, id: { gt: cursor.id } }],
      },
      orderBy: [{ at: 'asc' }, { id: 'asc' }],
      take: filter.limit,
      select: FIELDS,
    });
  }

  /** Which of these projects still exist. */
  async existingProjects(projectIds: readonly string[]): Promise<Set<string>> {
    const rows = await this.db.project.findMany({
      where: { id: { in: [...projectIds] } },
      select: { id: true },
    });
    return new Set(rows.map((row) => row.id));
  }

  countForProject(projectId: string): Promise<number> {
    return this.db.projectLogLine.count({ where: { projectId } });
  }

  /**
   * Drops the oldest lines beyond what a project keeps.
   *
   * By identifier rather than by date: the platform promises a number of recent
   * lines, not a length of time, because a project that printed nothing for a
   * month would otherwise have its log emptied for being quiet.
   */
  async prune(projectId: string, keep: number): Promise<number> {
    const boundary = await this.db.projectLogLine.findMany({
      where: { projectId },
      orderBy: [{ at: 'desc' }, { id: 'desc' }],
      skip: keep,
      take: 1,
      select: { at: true, id: true },
    });

    const oldest = boundary[0];
    if (!oldest) return 0;

    const { count } = await this.db.projectLogLine.deleteMany({
      where: {
        projectId,
        OR: [{ at: { lt: oldest.at } }, { at: oldest.at, id: { lte: oldest.id } }],
      },
    });

    return count;
  }
}
