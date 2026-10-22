import type { LogSource, LogStream } from '@platform/shared';
import type { Database } from '../../db/client.js';

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
  before?: string | undefined;
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

  async append(lines: readonly LogWrite[]): Promise<void> {
    if (lines.length === 0) return;
    await this.db.projectLogLine.createMany({ data: [...lines] });
  }

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
