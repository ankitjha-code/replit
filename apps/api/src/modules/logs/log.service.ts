import {
  DEFAULT_LOG_PAGE,
  MAX_LOG_LINE_LENGTH,
  type LogLine,
  type LogQuery,
  type LogResponse,
  type LogSource,
  type LogStream,
} from '@platform/shared';
import type { Logger } from 'pino';
import type { ProjectEventPublisher } from '../../events/project-event-bus.js';
import type { LogRecord, LogRepository, LogWrite } from './log.repository.js';

export interface LogServiceOptions {
  retainedLines: number;
  flushIntervalMs: number;
  flushLines: number;
}

export class LogService {
  private pending: LogWrite[] = [];

  private events?: ProjectEventPublisher;

  useEvents(events: ProjectEventPublisher): void {
    this.events = events;
  }
  private timer: ReturnType<typeof setTimeout> | undefined;

  private readonly dirty = new Set<string>();

  private writing: Promise<void> = Promise.resolve();

  private closed = false;

  constructor(
    private readonly logs: LogRepository,
    private readonly options: LogServiceOptions,
    private readonly log: Logger,
  ) {}

  record(input: {
    projectId: string;
    source: LogSource;
    sourceId: string;
    stream: LogStream;
    chunk: string;
    at?: Date;
  }): void {
    if (this.closed) return;

    const at = input.at ?? new Date();

    for (const raw of input.chunk.split('\n')) {
      const line = raw.replace(/\r+$/, '');
      if (line.length === 0) continue;

      this.pending.push({
        projectId: input.projectId,
        source: input.source,
        sourceId: input.sourceId,
        stream: input.stream,
        message: line.slice(0, MAX_LOG_LINE_LENGTH),
        at,
      });
    }

    if (this.pending.length >= this.options.flushLines) {
      void this.flush();
      return;
    }

    this.schedule();
  }

  async read(projectId: string, query: LogQuery): Promise<LogResponse> {
    await this.flush();

    const limit = query.limit ?? DEFAULT_LOG_PAGE;

    if (query.after) {
      const newer = await this.logs.after(projectId, {
        source: query.source,
        sourceId: query.sourceId,
        stream: query.stream,
        contains: query.contains,
        after: query.after,
        limit,
      });

      return {
        lines: newer.map(toLine),
        olderCursor: null,
        retainedLines: this.options.retainedLines,
        truncated: false,
      };
    }

    const records = await this.logs.page(projectId, {
      contains: query.contains,
      source: query.source,
      sourceId: query.sourceId,
      stream: query.stream,
      before: query.before,
      limit: limit + 1,
    });

    const page = records.slice(0, limit);
    const hasOlder = records.length > limit;

    const lines: LogLine[] = page.map(toLine).reverse();

    const held = await this.logs.countForProject(projectId);

    return {
      lines,
      olderCursor: hasOlder ? (page[page.length - 1]?.id ?? null) : null,
      retainedLines: this.options.retainedLines,
      truncated: held >= this.options.retainedLines,
    };
  }

  async export(projectId: string, query: LogQuery): Promise<string> {
    await this.flush();

    const out: string[] = [];
    let before: string | undefined;

    for (;;) {
      const page = await this.logs.page(projectId, {
        source: query.source,
        sourceId: query.sourceId,
        stream: query.stream,
        contains: query.contains,
        before,
        limit: 1_000,
      });
      if (page.length === 0) break;

      for (const record of page) {
        out.push(`${record.at.toISOString()} ${record.stream} ${record.message}`);
      }

      before = page[page.length - 1]?.id;
      if (page.length < 1_000) break;
    }

    return `${out.reverse().join('\n')}\n`;
  }

  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }

    this.writing = this.writing.then(() => this.write());
    return this.writing;
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.flush();
  }

  private schedule(): void {
    if (this.timer || this.pending.length === 0) return;

    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, this.options.flushIntervalMs);

    this.timer.unref?.();
  }

  private async write(): Promise<void> {
    const batch = this.pending;
    if (batch.length === 0) return;

    this.pending = [];

    try {
      await this.appendKeepingTheLiving(batch);
      for (const line of batch) this.dirty.add(line.projectId);

      for (const projectId of new Set(batch.map((line) => line.projectId))) {
        this.events?.publish(projectId, { type: 'logs.appended' });
      }
    } catch (error) {
      this.log.error({ err: error, lines: batch.length }, 'log lines could not be written');
      return;
    }

    await this.pruneDirty();
  }

  private async appendKeepingTheLiving(batch: LogWrite[]): Promise<void> {
    try {
      await this.logs.append(batch);
    } catch (error) {
      if ((error as { code?: unknown }).code !== 'P2003') throw error;
      const alive = await this.logs.existingProjects([...new Set(batch.map((l) => l.projectId))]);
      const kept = batch.filter((line) => alive.has(line.projectId));
      if (kept.length > 0) await this.logs.append(kept);
      this.log.debug(
        { dropped: batch.length - kept.length },
        'log lines for deleted projects were dropped',
      );
    }
  }

  private async pruneDirty(): Promise<void> {
    const projects = [...this.dirty];
    this.dirty.clear();

    for (const projectId of projects) {
      try {
        const removed = await this.logs.prune(projectId, this.options.retainedLines);
        if (removed > 0) {
          this.log.debug({ projectId, removed }, 'old log lines dropped');
        }
      } catch (error) {
        this.log.error({ err: error, projectId }, 'old log lines could not be dropped');
      }
    }
  }
}

function toLine(record: LogRecord): LogLine {
  return {
    id: record.id,
    source: record.source,
    sourceId: record.sourceId,
    stream: record.stream === 'stderr' ? 'stderr' : 'stdout',
    message: record.message,
    at: record.at.toISOString(),
  };
}
