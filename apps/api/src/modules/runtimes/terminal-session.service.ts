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

/**
 * Shells that outlive the socket showing them.
 *
 * Before this, a terminal was the socket: closing one closed the other, so
 * reloading the page killed whatever was running in it. That is the wrong
 * trade for a development tool. A build, a watch process or a long install is
 * exactly what someone has open when they reload, and losing it is losing the
 * work rather than the window.
 *
 * So a session is a server-side object with an identity. A socket attaches to
 * one, detaches from it, and another socket can attach to the same one later
 * and be shown what it missed.
 *
 * ## Surviving a restart
 *
 * A shell is started **detached inside the container** rather than as a stream
 * this process holds, and a row records that it is there. Nothing load-bearing
 * lives in this process, so a deploy of the platform no longer kills an install
 * or a watch process somebody had running — which was the one moment nobody
 * chose and the hardest to explain.
 *
 * Attaching is a fresh connection to a shell that was already running, whether
 * it was started a second ago or before the last restart. The two cases are the
 * same code path on purpose: a resume that only worked within one process
 * lifetime would be a resume that fails exactly when it matters.
 *
 * Two things are still **not** claimed:
 *
 * - **Not every environment can do it.** The detached shell needs a couple of
 *   ordinary tools in the image. Where they are missing the platform falls back
 *   to holding the stream itself, records the session as not durable, and says
 *   so rather than promising a resume that will fail.
 * - **A session is not kept forever.** One that nobody is attached to is closed
 *   after an idle period, because a shell nobody will ever attach to again is a
 *   process nobody will ever stop.
 */

/**
 * Marks the refusal that means "this project has enough shells already".
 *
 * Carried in the error's details rather than read out of its prose, because a
 * gateway has to turn this into a protocol code and matching on a message is
 * how a reworded sentence silently changes behaviour.
 */
export const TOO_MANY_TERMINALS = 'too-many-terminals';

/** A live shell, and everything known about it. */
interface LiveSession {
  id: string;
  projectId: string;
  /**
   * Who opened it.
   *
   * A session carries one person's shell: their history, their half-typed
   * command, their working directory. Another member of the project can open
   * their own, and cannot resume this one, so being shown a project never
   * means being shown what someone else is typing into it.
   */
  userId: string;
  /**
   * The runtime it lives in.
   *
   * Held so that stopping a runtime closes its sessions. A session pointing
   * into a container that is gone would be offered for resuming and fail.
   */
  runtimeId: string;
  /** True when the shell is a container process rather than a held stream. */
  durable: boolean;
  shell: TerminalSession;
  scrollback: Scrollback;
  size: TerminalSize;
  createdAt: Date;
  lastActiveAt: Date;
  /** When the last socket left, or null while one is attached. */
  detachedAt: Date | null;
  /** Where live output goes, when anything is listening. */
  socket: SessionSocket | undefined;
  /** True once the shell has ended; the session is then closed. */
  ended: boolean;
}

/** What a gateway gives the service so it can drive one socket. */
export interface SessionSocket {
  onOutput(text: string): void;
  onExit(code: number | null): void;
  /** Another socket resumed this session, so this one is finished. */
  onTakenOver(): void;
}

/** A session as handed back to whoever attached to it. */
export interface AttachedSession {
  id: string;
  /** True when this attached to a shell that was already running. */
  resumed: boolean;
  /** What the shell has printed, for rebuilding the screen. */
  replay: string;
  /** Whether older output was dropped before the replay above. */
  truncated: boolean;
  write(data: string): void;
  resize(size: TerminalSize): Promise<void>;
  /** Leaves the shell running. The counterpart to attaching. */
  detach(): void;
  /** Ends the shell. What a person means by closing a terminal. */
  close(): Promise<void>;
}

export interface TerminalSessionOptions {
  /** Shells one project may have at once, attached or not. */
  maxPerProject: number;
  /** How much of what a shell printed is kept for a screen to be rebuilt. */
  scrollbackBytes: number;
  /** How long a session nobody is attached to is kept before it is closed. */
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

  /**
   * Opens a new shell, or resumes one that is already running.
   *
   * Resuming is asked for by identifier. An identifier that names nothing is
   * refused rather than quietly opening a new shell: the client asked to get
   * its work back, and silently giving it a fresh prompt looks identical to
   * having lost it.
   */
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

  /**
   * The caller's own sessions in one project, newest first.
   *
   * Read from the rows rather than from memory, which is the difference between
   * a list that shows what this process happens to be holding and one that
   * shows what actually exists. After a restart the second is the only useful
   * answer: the sessions are there, and nothing in this process knows about
   * them until somebody attaches.
   */
  async list(projectId: string, userId: string): Promise<TerminalSessionSummary[]> {
    const records = await this.terminals.listForUser(projectId, userId);

    return records.map((record) => ({
      id: record.id,
      createdAt: record.createdAt.toISOString(),
      lastActiveAt: record.lastActiveAt.toISOString(),
      // Attached means a socket in *this* process. One attached elsewhere reads
      // as not attached here, which is the honest answer from where this stands.
      attached: this.sessions.get(record.id)?.socket !== undefined,
      size: { rows: record.rows, columns: record.columns },
    }));
  }

  /**
   * Ends one session on purpose.
   *
   * Scoped to the owner, so an identifier guessed or taken from somewhere else
   * cannot be used to kill another person's shell. An unknown identifier is
   * not an error: closing something that is already gone is what was wanted.
   */
  async closeSession(sessionId: string, projectId: string, userId: string): Promise<void> {
    // Anything that cannot be one of ours is already gone, which is what was
    // asked for. Letting it reach the database would turn a typo into a 500.
    if (!isSessionId(sessionId)) return;

    const session = this.sessions.get(sessionId);

    if (session) {
      if (session.projectId !== projectId || session.userId !== userId) return;
      await this.destroy(session, 'closed by its owner');
      return;
    }

    /*
     * Closing one this process never attached to.
     *
     * Ordinary after a restart: the row and the shell are both there and
     * nothing here is holding either. The ownership check is the same one, done
     * in the query that finds the row.
     */
    const record = await this.terminals.findOwned(sessionId, projectId, userId);
    if (!record) return;

    await this.runtimes.stopDurableTerminal(projectId, sessionId).catch(() => undefined);
    await this.terminals.deleteById(sessionId);
  }

  /**
   * Closes every session in one runtime.
   *
   * Called when the runtime is going away. The shells die with the container
   * either way; this stops the platform offering to resume something that no
   * longer exists, and stops it holding streams that are about to end.
   */
  async releaseRuntime(runtimeId: string): Promise<void> {
    const doomed = [...this.sessions.values()].filter((s) => s.runtimeId === runtimeId);
    await Promise.all(doomed.map((s) => this.destroy(s, 'the project was stopped')));

    /*
     * And the rows for sessions this process never held.
     *
     * The shells are gone either way — they were processes in a container that
     * is being removed — so there is nothing to signal. What is left is the
     * bookkeeping, and leaving it would offer resumes into a container that no
     * longer exists.
     */
    for (const record of await this.terminals.listForRuntime(runtimeId)) {
      await this.terminals.deleteById(record.id).catch(() => undefined);
    }
  }

  /** Live sessions, for tests and for shutdown reporting. */
  get openCount(): number {
    return this.sessions.size;
  }

  /**
   * Starts closing sessions nobody came back to.
   *
   * Separate from the constructor so a test can drive the sweep directly
   * rather than waiting for a timer, and so nothing schedules work in a
   * process that only built the object to inspect it.
   */
  startReaping(intervalMs: number): void {
    if (this.reaper) return;
    this.reaper = setInterval(() => void this.reapIdle(), intervalMs);
    // Never a reason to hold the process open.
    this.reaper.unref();
  }

  /** Closes detached sessions that have been idle longer than the limit. */
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

    /*
     * And the ones nothing in this process is holding.
     *
     * A durable shell that survived a restart is nobody's until somebody
     * attaches, so without this it would never be reaped and would hold a
     * process in a container for ever — the exact leak the idle sweep exists to
     * prevent, reintroduced by the feature that made sessions survive.
     */
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

  /** Ends every session. Used on shutdown. */
  async closeAll(): Promise<void> {
    if (this.reaper) clearInterval(this.reaper);
    this.reaper = undefined;
    const all = [...this.sessions.values()];
    await Promise.all(all.map((s) => this.destroy(s, 'the platform is shutting down')));
  }

  // -------------------------------------------------------------------------

  private async open(
    projectId: string,
    userId: string,
    socket: SessionSocket,
    size: TerminalSize,
  ): Promise<AttachedSession> {
    /*
     * The limit counts shells, not sockets.
     *
     * It used to count sockets, which was the same number only because the two
     * were the same thing. Now that a shell outlives its socket, counting
     * sockets would let someone open a shell, reload, and repeat, holding an
     * unbounded number of processes while never having more than one window.
     */
    /*
     * Counted from the rows, not from memory.
     *
     * A shell that survived a restart is real and is holding a process, and a
     * count that only saw this process's own sessions would let the ceiling be
     * bypassed by restarting the platform.
     */
    const existing = await this.terminals.countForProject(projectId);
    if (existing >= this.options.maxPerProject) {
      throw new AppError(
        'PRECONDITION_FAILED',
        'This project already has as many terminals open as it is allowed. Close one first.',
        { details: { reason: TOO_MANY_TERMINALS } },
      );
    }

    /*
     * The identifier is chosen before the shell exists.
     *
     * A detached shell is named by it inside the container, so it has to be
     * decided first. That is the opposite of the usual order and is what lets
     * the session be found again with nothing held in this process.
     */
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

  /**
   * Starts the shell, preferring one that will outlive this process.
   *
   * The fallback is not a failure path to be embarrassed about: the detached
   * shell needs `script` and a named pipe, and an image without them is a real
   * possibility. What matters is that the difference is recorded rather than
   * discovered by somebody whose resume fails after a deploy.
   */
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
      /*
       * Rethrown when the project is not running.
       *
       * That refusal is the caller's to see — "start the project first" — and
       * falling back would turn it into a second identical failure one line
       * later, with a worse message.
       */
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

    /*
     * One answer for every way a resume can fail.
     *
     * Wrong project, wrong owner, unknown identifier and already ended are all
     * reported the same way, because distinguishing them would say whether
     * someone else's session exists.
     */
    if (!session || session.ended || session.projectId !== projectId || session.userId !== userId) {
      throw new AppError('NOT_FOUND', 'That terminal is no longer open.');
    }

    /*
     * The newer socket wins.
     *
     * Two sockets on one shell would interleave keystrokes into nonsense. The
     * common case is not two people: it is one person reloading, where the old
     * socket has not been reaped yet, so refusing would fail the very thing
     * this feature exists to do.
     */
    const displaced = session.socket;
    session.socket = socket;
    session.detachedAt = null;
    session.lastActiveAt = new Date();
    if (displaced) displaced.onTakenOver();

    /*
     * The same replay for every kind of session.
     *
     * A durable session resumed in the process that has been holding it has a
     * complete scrollback here, because its attachment kept streaming while
     * nobody watched. One reclaimed after a restart starts with an empty
     * scrollback, and the fresh attachment's replay of the container's log
     * flows into it — so reading it here is right in both cases, and treating
     * durable sessions specially would throw away a correct screen.
     */
    const { text, truncated } = session.scrollback.read();
    return this.handle(session, socket, { resumed: true, replay: text, truncated });
  }

  /**
   * Picks up a session this process never opened.
   *
   * The case a restart creates: the row says a shell exists, and the shell is a
   * process inside the container rather than anything this process was holding.
   * Attaching is the same connection it would have made anyway.
   *
   * A session that was never durable cannot be reclaimed, and neither can one
   * whose shell has since ended. Both come back as nothing, which the caller
   * turns into the same "no longer open" the other failures give.
   */
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
      // The shell is gone. The row is the only thing left of it, and keeping one
      // for a session nobody can attach to is how a list fills with ghosts.
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
      // Empty on purpose: what this session printed lives in the container, and
      // the attachment above is already replaying it.
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

  /** Points the shell's output and exit at whatever socket is attached now. */
  private wire(session: LiveSession): void {
    session.shell.onData((chunk) => {
      const text = session.scrollback.append(chunk);
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

      /*
       * The row goes with the shell.
       *
       * A shell that ended by itself — somebody typed `exit` — is finished, and
       * its row counts against the project's ceiling. Leaving it would take a
       * slot away for every shell that ever exited, until nobody could open one.
       */
      void this.terminals.deleteById(session.id).catch((error: unknown) => {
        this.log.error({ err: error, sessionId: session.id }, 'a terminal record was left behind');
      });
    });
  }

  /**
   * The caller's view of one session.
   *
   * Bound to the socket it was made for, not just to the session. Every handle
   * on a session closes over the same object, so a handle that has been
   * displaced would otherwise be able to detach the socket that displaced it.
   */
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
        /*
         * Only the socket that is actually on the session may step off it.
         *
         * A displaced socket closes a moment after being taken over, and that
         * close reaches its own handle. Without this check it would detach the
         * session the newer socket is now using, and the reload this feature
         * exists for would silently produce a session nobody is attached to.
         */
        if (session.socket !== socket) return;
        session.socket = undefined;
        session.detachedAt = new Date();
      },

      close: () => this.destroy(session, 'closed'),
    };
  }

  private async destroy(session: LiveSession, reason: string): Promise<void> {
    this.sessions.delete(session.id);

    /*
     * The row goes whatever else happens.
     *
     * A row outliving its shell is worse than no row: it offers a resume that
     * cannot work, and the count it contributes to keeps somebody from opening
     * a terminal they are entitled to.
     */
    await this.terminals.deleteById(session.id).catch((error: unknown) => {
      this.log.error({ err: error, sessionId: session.id }, 'a terminal record was left behind');
    });

    if (session.ended) return;
    session.ended = true;
    const socket = session.socket;
    session.socket = undefined;
    socket?.onExit(null);

    /*
     * A durable shell has to be told, because closing the attachment does not
     * reach it. That asymmetry is the point of the whole mechanism: detaching
     * leaves it running, so ending it is a separate act.
     */
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

/** Whether a value could be an identifier this service issued. */
function isSessionId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
