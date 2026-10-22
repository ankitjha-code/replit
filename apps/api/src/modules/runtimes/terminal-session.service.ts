import { randomUUID } from 'node:crypto';
import {
  DEFAULT_TERMINAL_SIZE,
  type TerminalSessionSummary,
  type TerminalSize,
} from '@platform/shared';
import type { Logger } from 'pino';
import { AppError } from '../../errors/app-error.js';
import type { TerminalSession } from '../../execution/provider.js';
import { Scrollback } from './scrollback.js';
import type { RuntimeService } from './runtime.service.js';
import type { TerminalRepository, TerminalSessionRecord } from './terminal.repository.js';

export const TOO_MANY_TERMINALS = 'too-many-terminals';

interface LiveSession {
  id: string;
  projectId: string;
  userId: string;
  runtimeId: string;
  durable: boolean;
  shell: TerminalSession;
  scrollback: Scrollback;
  size: TerminalSize;
  createdAt: Date;
  lastActiveAt: Date;
  detachedAt: Date | null;
  socket: SessionSocket | undefined;
  ended: boolean;
}

export interface SessionSocket {
  onOutput(text: string): void;
  onExit(code: number | null): void;
  onTakenOver(): void;
}

export interface AttachedSession {
  id: string;
  resumed: boolean;
  replay: string;
  truncated: boolean;
  write(data: string): void;
  resize(size: TerminalSize): Promise<void>;
  detach(): void;
  close(): Promise<void>;
}

export interface TerminalSessionOptions {
  maxPerProject: number;
  scrollbackBytes: number;
  idleMs: number;
}

export class TerminalSessionService {
  private readonly sessions = new Map<string, LiveSession>();
  private reaper: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly runtimes: RuntimeService,
    private readonly terminals: TerminalRepository,
    private readonly options: TerminalSessionOptions,
    private readonly log: Logger,
  ) {}

  async attach(
    projectId: string,
    userId: string,
    socket: SessionSocket,
    request: { sessionId?: string | undefined; size?: TerminalSize | undefined },
  ): Promise<AttachedSession> {
    if (request.sessionId !== undefined) {
      return this.resume(request.sessionId, projectId, userId, socket);
    }
    return this.open(projectId, userId, socket, request.size ?? DEFAULT_TERMINAL_SIZE);
  }

  async list(projectId: string, userId: string): Promise<TerminalSessionSummary[]> {
    const records = await this.terminals.listForUser(projectId, userId);

    return records.map((record) => ({
      id: record.id,
      createdAt: record.createdAt.toISOString(),
      lastActiveAt: record.lastActiveAt.toISOString(),
      attached: this.sessions.get(record.id)?.socket !== undefined,
      size: { rows: record.rows, columns: record.columns },
    }));
  }

  async closeSession(sessionId: string, projectId: string, userId: string): Promise<void> {
    if (!isSessionId(sessionId)) return;

    const session = this.sessions.get(sessionId);

    if (session) {
      if (session.projectId !== projectId || session.userId !== userId) return;
      await this.destroy(session, 'closed by its owner');
      return;
    }

    const record = await this.terminals.findOwned(sessionId, projectId, userId);
    if (!record) return;

    await this.runtimes.stopDurableTerminal(projectId, sessionId).catch(() => undefined);
    await this.terminals.deleteById(sessionId);
  }

  async releaseRuntime(runtimeId: string): Promise<void> {
    const doomed = [...this.sessions.values()].filter((s) => s.runtimeId === runtimeId);
    await Promise.all(doomed.map((s) => this.destroy(s, 'the project was stopped')));

    for (const record of await this.terminals.listForRuntime(runtimeId)) {
      await this.terminals.deleteById(record.id).catch(() => undefined);
    }
  }

  get openCount(): number {
    return this.sessions.size;
  }

  startReaping(intervalMs: number): void {
    if (this.reaper) return;
    this.reaper = setInterval(() => void this.reapIdle(), intervalMs);
    this.reaper.unref();
  }

  async reapIdle(now: Date = new Date()): Promise<void> {
    const expired = [...this.sessions.values()].filter(
      (s) => s.detachedAt !== null && now.getTime() - s.detachedAt.getTime() >= this.options.idleMs,
    );
    for (const session of expired) {
      this.log.info(
        { sessionId: session.id, projectId: session.projectId },
        'closing idle terminal session',
      );
      await this.destroy(session, 'idle for too long');
    }

    const before = new Date(now.getTime() - this.options.idleMs);

    for (const record of await this.terminals.listIdle(before)) {
      if (this.sessions.has(record.id)) continue;

      this.log.info(
        { sessionId: record.id, projectId: record.projectId },
        'closing a surviving terminal nobody came back to',
      );

      await this.runtimes.stopDurableTerminal(record.projectId, record.id).catch(() => undefined);
      await this.terminals.deleteById(record.id).catch(() => undefined);
    }
  }

  async closeAll(): Promise<void> {
    if (this.reaper) clearInterval(this.reaper);
    this.reaper = undefined;
    const all = [...this.sessions.values()];
    await Promise.all(all.map((s) => this.destroy(s, 'the platform is shutting down')));
  }

  private async open(
    projectId: string,
    userId: string,
    socket: SessionSocket,
    size: TerminalSize,
  ): Promise<AttachedSession> {
    const existing = await this.terminals.countForProject(projectId);
    if (existing >= this.options.maxPerProject) {
      throw new AppError(
        'PRECONDITION_FAILED',
        'This project already has as many terminals open as it is allowed. Close one first.',
        { details: { reason: TOO_MANY_TERMINALS } },
      );
    }

    const id = randomUUID();

    const { runtimeId, shell, durable } = await this.startShell(projectId, id, size);

    const now = new Date();
    const session: LiveSession = {
      id,
      projectId,
      userId,
      runtimeId,
      durable,
      shell,
      scrollback: new Scrollback(this.options.scrollbackBytes),
      size,
      createdAt: now,
      lastActiveAt: now,
      detachedAt: null,
      socket,
      ended: false,
    };

    await this.terminals.create({
      id,
      projectId,
      userId,
      runtimeId,
      durable,
      rows: size.rows,
      columns: size.columns,
    });

    this.sessions.set(session.id, session);
    this.wire(session);

    return this.handle(session, socket, { resumed: false, replay: '', truncated: false });
  }

  private async startShell(
    projectId: string,
    terminalId: string,
    size: TerminalSize,
  ): Promise<{ runtimeId: string; shell: TerminalSession; durable: boolean }> {
    try {
      const { runtimeId } = await this.runtimes.startDurableTerminal(projectId, terminalId, size);
      const shell = await this.runtimes.attachDurableTerminal(projectId, terminalId);
      return { runtimeId, shell, durable: true };
    } catch (error) {
      if (error instanceof AppError && error.code === 'PRECONDITION_FAILED') throw error;

      this.log.warn(
        { err: error, projectId },
        'this environment cannot hold a terminal across a restart; falling back',
      );

      const { runtimeId, session: shell } = await this.runtimes.openTerminal(projectId, size);
      return { runtimeId, shell, durable: false };
    }
  }

  private async resume(
    sessionId: string,
    projectId: string,
    userId: string,
    socket: SessionSocket,
  ): Promise<AttachedSession> {
    const session =
      this.sessions.get(sessionId) ?? (await this.reclaim(sessionId, projectId, userId));

    if (!session || session.ended || session.projectId !== projectId || session.userId !== userId) {
      throw new AppError('NOT_FOUND', 'That terminal is no longer open.');
    }

    const displaced = session.socket;
    session.socket = socket;
    session.detachedAt = null;
    session.lastActiveAt = new Date();
    if (displaced) displaced.onTakenOver();

    const { text, truncated } = session.scrollback.read();
    return this.handle(session, socket, { resumed: true, replay: text, truncated });
  }

  private async reclaim(
    sessionId: string,
    projectId: string,
    userId: string,
  ): Promise<LiveSession | undefined> {
    if (!isSessionId(sessionId)) return undefined;

    const record: TerminalSessionRecord | null = await this.terminals.findOwned(
      sessionId,
      projectId,
      userId,
    );

    if (!record || !record.durable) return undefined;

    if (!(await this.runtimes.durableTerminalRunning(projectId, sessionId))) {
      await this.terminals.deleteById(sessionId).catch(() => undefined);
      return undefined;
    }

    let shell: TerminalSession;
    try {
      shell = await this.runtimes.attachDurableTerminal(projectId, sessionId);
    } catch (error) {
      this.log.warn({ err: error, sessionId }, 'a surviving terminal could not be reattached');
      return undefined;
    }

    const session: LiveSession = {
      id: record.id,
      projectId: record.projectId,
      userId: record.userId,
      runtimeId: record.runtimeId,
      durable: true,
      shell,
      scrollback: new Scrollback(this.options.scrollbackBytes),
      size: { rows: record.rows, columns: record.columns },
      createdAt: record.createdAt,
      lastActiveAt: new Date(),
      detachedAt: null,
      socket: undefined,
      ended: false,
    };

    this.sessions.set(session.id, session);
    this.wire(session);

    this.log.info(
      { sessionId, projectId },
      'a terminal that outlived the control plane was picked up again',
    );

    return session;
  }

  private wire(session: LiveSession): void {
    const banner = new ScriptBannerFilter();

    session.shell.onData((chunk) => {
      const visible = banner.push(chunk);
      if (visible.length === 0) return;
      const text = session.scrollback.append(visible);
      if (text.length === 0) return;
      session.lastActiveAt = new Date();
      session.socket?.onOutput(text);
    });

    session.shell.onExit((code) => {
      const tail = session.scrollback.end();
      if (tail.length > 0) session.socket?.onOutput(tail);
      session.ended = true;
      session.socket?.onExit(code);
      session.socket = undefined;
      this.sessions.delete(session.id);

      void this.terminals.deleteById(session.id).catch((error: unknown) => {
        this.log.error({ err: error, sessionId: session.id }, 'a terminal record was left behind');
      });
    });
  }

  private handle(
    session: LiveSession,
    socket: SessionSocket,
    opened: { resumed: boolean; replay: string; truncated: boolean },
  ): AttachedSession {
    return {
      id: session.id,
      resumed: opened.resumed,
      replay: opened.replay,
      truncated: opened.truncated,

      write: (data) => {
        session.lastActiveAt = new Date();
        session.shell.write(data);
      },

      resize: async (size) => {
        session.size = size;
        session.lastActiveAt = new Date();
        await session.shell.resize(size);
      },

      detach: () => {
        if (session.socket !== socket) return;
        session.socket = undefined;
        session.detachedAt = new Date();
      },

      close: () => this.destroy(session, 'closed'),
    };
  }

  private async destroy(session: LiveSession, reason: string): Promise<void> {
    this.sessions.delete(session.id);

    await this.terminals.deleteById(session.id).catch((error: unknown) => {
      this.log.error({ err: error, sessionId: session.id }, 'a terminal record was left behind');
    });

    if (session.ended) return;
    session.ended = true;
    const socket = session.socket;
    session.socket = undefined;
    socket?.onExit(null);

    if (session.durable) {
      await this.runtimes.stopDurableTerminal(session.projectId, session.id).catch(() => undefined);
    }

    try {
      await session.shell.close();
    } catch (error) {
      this.log.warn(
        { err: error, sessionId: session.id, reason },
        'terminal session could not be closed cleanly',
      );
    }
  }
}

export class ScriptBannerFilter {
  private pending: Buffer | undefined = Buffer.alloc(0);

  push(chunk: Uint8Array): Uint8Array {
    return stripTrailer(this.stripHeader(Buffer.from(chunk)));
  }

  private stripHeader(chunk: Buffer): Buffer {
    if (this.pending === undefined) return chunk;

    const joined = Buffer.concat([this.pending, chunk]);
    const compared = Math.min(joined.length, SCRIPT_HEADER.length);
    if (!joined.subarray(0, compared).equals(SCRIPT_HEADER.subarray(0, compared))) {
      this.pending = undefined;
      return joined;
    }

    const newline = joined.indexOf(0x0a);
    if (newline === -1) {
      if (joined.length > MAX_SCRIPT_HEADER_BYTES) {
        this.pending = undefined;
        return joined;
      }
      this.pending = joined;
      return EMPTY;
    }

    this.pending = undefined;
    return joined.subarray(newline + 1);
  }
}

const SCRIPT_HEADER = Buffer.from('Script started on ');
const MAX_SCRIPT_HEADER_BYTES = 4_096;
const EMPTY = Buffer.alloc(0);
const SCRIPT_TRAILER = /\r?\n?Script done on [^\n]*\]\r?\n?$/;

function stripTrailer(chunk: Buffer): Buffer {
  if (chunk.length === 0 || !chunk.includes('Script done on ')) return chunk;
  const text = chunk.toString('latin1');
  const match = SCRIPT_TRAILER.exec(text);
  return match ? chunk.subarray(0, match.index) : chunk;
}

function isSessionId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
