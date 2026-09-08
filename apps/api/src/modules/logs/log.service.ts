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

/**
 * What a project's applications printed, kept.
 *
 * The durable counterpart to the in-memory buffer the console reads. That
 * buffer is the right shape for watching something run and the wrong one for
 * every question asked afterwards: what did it print before it crashed, what
 * was the deployment doing at four in the morning, did it ever start at all.
 * All of those are about output that has scrolled past or that a restart threw
 * away.
 *
 * Three properties shape the implementation, and each is a refusal to do the
 * obvious thing:
 *
 *  1. **Writes are batched.** A program printing a thousand lines a second is
 *     ordinary. A round trip per line would make keeping a log the most
 *     expensive thing about running anything, and the cost would fall on the
 *     projects that print the most, which are the ones that need it.
 *  2. **Recording never fails a caller.** This is fed from a stream handler on
 *     a container's output. There is nobody to return an error to, and losing
 *     a log line must never be able to stop a program running.
 *  3. **Retention is a number of lines, not a length of time.** The platform
 *     promises the last N lines, which is a promise it can keep. A project that
 *     printed nothing for a month would otherwise have its log emptied for
 *     being quiet.
 */

export interface LogServiceOptions {
  /** Lines one project keeps before the oldest are dropped. */
  retainedLines: number;
  /** How long a line may wait in memory before it is written. */
  flushIntervalMs: number;
  /** How many may wait before a flush happens regardless. */
  flushLines: number;
}

export class LogService {
  /** Lines not yet written, in arrival order across every project. */
  private pending: LogWrite[] = [];

  /** Where "new lines were written" is announced, for a live tail. */
  private events?: ProjectEventPublisher;

  useEvents(events: ProjectEventPublisher): void {
    this.events = events;
  }
  private timer: ReturnType<typeof setTimeout> | undefined;

  /** Projects that have had lines written since they were last pruned. */
  private readonly dirty = new Set<string>();

  /** Serialises flushes, so two cannot interleave on one table. */
  private writing: Promise<void> = Promise.resolve();

  private closed = false;

  constructor(
    private readonly logs: LogRepository,
    private readonly options: LogServiceOptions,
    private readonly log: Logger,
  ) {}

  /**
   * Records one chunk of output.
   *
   * Takes a chunk rather than a line because that is what a container hands
   * over: the platform does not control where a write lands, so a chunk may be
   * several lines, half of one, or both. It is split here and each piece stored
   * as its own row, which is what makes a log readable and filterable at all.
   *
   * Synchronous and never throws. It is called from a stream handler.
   */
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
      /*
       * Carriage returns are dropped rather than kept.
       *
       * A program on a pseudo-terminal ends its lines with them, and a log that
       * stored them would put an invisible character at the end of every line
       * that anything reading the log would have to strip again.
       */
      const line = raw.replace(/\r+$/, '');
      if (line.length === 0) continue;

      this.pending.push({
        projectId: input.projectId,
        source: input.source,
        sourceId: input.sourceId,
        stream: input.stream,
        // Truncated rather than dropped: a program can print a megabyte without
        // a newline, and the end of an absurd line is a smaller loss than the
        // line not appearing where it happened.
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

  /** A page of a project's log, oldest first. */
  async read(projectId: string, query: LogQuery): Promise<LogResponse> {
    /*
     * Anything still in memory is written first.
     *
     * Without this, opening the log immediately after something printed would
     * show everything except the part somebody is looking for, which is the
     * commonest way this feature would be used and the one moment it would seem
     * broken.
     */
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
        // A tail appends; it never pages backwards from here.
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
      // One more than asked for, so "is there another page" is answered by
      // looking rather than by guessing from a full page.
      limit: limit + 1,
    });

    const page = records.slice(0, limit);
    const hasOlder = records.length > limit;

    const lines: LogLine[] = page
      .map(toLine)
      // The query reads backwards; a log is read forwards.
      .reverse();

    const held = await this.logs.countForProject(projectId);

    return {
      lines,
      olderCursor: hasOlder ? (page[page.length - 1]?.id ?? null) : null,
      retainedLines: this.options.retainedLines,
      // At the ceiling means older output has already been dropped, which is
      // not the same as there being nothing older.
      truncated: held >= this.options.retainedLines,
    };
  }

  /**
   * Every line the project still has, as plain text, for a download.
   *
   * Everything retained rather than a page: somebody exporting a log is taking
   * it somewhere to read properly, and a page would be the one thing they did
   * not want. Bounded anyway, because retention is.
   */
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

    // Collected newest first; a log file is read oldest first.
    return `${out.reverse().join('\n')}\n`;
  }

  /**
   * Writes everything waiting, and prunes what has grown past the ceiling.
   *
   * Never rejects. Called from a timer, from a read, and from shutdown, and in
   * two of those three there is nobody to catch.
   */
  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }

    this.writing = this.writing.then(() => this.write());
    return this.writing;
  }

  /** Writes what is left and stops accepting more. */
  async close(): Promise<void> {
    this.closed = true;
    await this.flush();
  }

  // -------------------------------------------------------------------------

  private schedule(): void {
    if (this.timer || this.pending.length === 0) return;

    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, this.options.flushIntervalMs);

    // A pending flush must not hold the process open at shutdown: what it is
    // waiting to write is written by `close` anyway.
    this.timer.unref?.();
  }

  private async write(): Promise<void> {
    const batch = this.pending;
    if (batch.length === 0) return;

    this.pending = [];

    try {
      await this.appendKeepingTheLiving(batch);
      for (const line of batch) this.dirty.add(line.projectId);

      /*
       * One announcement per project per batch, not per line.
       *
       * A chatty program writes thousands of lines a second; an event per line
       * would put the same flood on every open log page. Batching is already
       * what the timer does, so the tail updates at the same rhythm as the
       * writes.
       */
      for (const projectId of new Set(batch.map((line) => line.projectId))) {
        this.events?.publish(projectId, { type: 'logs.appended' });
      }
    } catch (error) {
      /*
       * The batch is dropped rather than retried.
       *
       * Retrying would mean holding output in memory while whatever broke stays
       * broken, which turns a logging failure into a memory leak on the busiest
       * projects. Losing log lines is bad; taking the control plane down to
       * avoid losing them is worse.
       */
      this.log.error({ err: error, lines: batch.length }, 'log lines could not be written');
      return;
    }

    await this.pruneDirty();
  }

  /**
   * Writes a batch, and survives a project being deleted while it waited.
   *
   * A batch mixes lines from many projects. If one of them was deleted in the
   * second before the flush, the database refuses the whole insert, and
   * dropping the batch would lose every other project's lines with it. Found
   * running the production stack, where deleting a project with a live
   * deployment is ordinary. The lines of projects that are gone are dropped;
   * everybody else's are written.
   */
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

  /**
   * Trims the projects that have just been written to.
   *
   * After the write rather than before, and only for projects that actually
   * grew, so a quiet installation does no pruning work at all.
   */
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
