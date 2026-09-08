import { describe, expect, it, vi } from 'vitest';
import type { TerminalSize } from '@platform/shared';
import type { TerminalSession } from '../../execution/provider.js';
import type { RuntimeService } from './runtime.service.js';
import type { TerminalRepository, TerminalSessionRecord } from './terminal.repository.js';
import { TerminalSessionService, type SessionSocket } from './terminal-session.service.js';

/**
 * Sessions, without a socket or a container.
 *
 * Everything here is a rule about what a session is and who may have it, which
 * is exactly the part that should not need a server to exercise. The gateway's
 * own tests drive real sockets; these drive the decisions.
 */

/** A shell that can be pushed around from a test. */
class FakeShell implements TerminalSession {
  readonly written: string[] = [];
  readonly sizes: TerminalSize[] = [];
  closed = false;

  private data: ((chunk: Uint8Array) => void) | undefined;
  private exit: ((code: number | null) => void) | undefined;

  onData(listener: (chunk: Uint8Array) => void): void {
    this.data = listener;
  }
  onExit(listener: (code: number | null) => void): void {
    this.exit = listener;
  }
  write(data: string): void {
    this.written.push(data);
  }
  resize(size: TerminalSize): Promise<void> {
    this.sizes.push(size);
    return Promise.resolve();
  }
  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }

  /** Pretends the process printed something. */
  emit(text: string): void {
    this.data?.(new TextEncoder().encode(text));
  }
  /** Pretends the process ended. */
  end(code: number | null): void {
    this.exit?.(code);
  }
}

function recordingSocket() {
  const output: string[] = [];
  const exits: (number | null)[] = [];
  let takenOver = 0;
  const socket: SessionSocket = {
    onOutput: (text) => output.push(text),
    onExit: (code) => exits.push(code),
    onTakenOver: () => {
      takenOver += 1;
    },
  };
  return { socket, output, exits, takenOver: () => takenOver };
}

function build(
  options: { maxPerProject?: number; scrollbackBytes?: number; idleMs?: number } = {},
) {
  const shells: FakeShell[] = [];
  let runtimeId = 'runtime-1';

  const runtimes = {
    openTerminal: vi.fn(() => {
      const shell = new FakeShell();
      shells.push(shell);
      return Promise.resolve({ runtimeId, session: shell as TerminalSession });
    }),
  } as unknown as RuntimeService;

  /*
   * A repository that keeps rows in memory.
   *
   * Listing and the per-project ceiling are read from rows, so a stub that
   * remembered nothing would make those tests pass or fail for the wrong
   * reason. This keeps the behaviour real without making every case a
   * database test.
   */
  const rows = new Map<string, TerminalSessionRecord>();
  const terminals = {
    create: (input: Omit<TerminalSessionRecord, 'createdAt' | 'lastActiveAt'>) => {
      // Strictly increasing, so "newest first" is decided by order of creation
      // rather than by two opens landing in the same millisecond.
      const at = new Date(Date.now() + rows.size);
      const record = { ...input, createdAt: at, lastActiveAt: at };
      rows.set(input.id, record);
      return Promise.resolve(record);
    },
    findOwned: (id: string, projectId: string, userId: string) => {
      const row = rows.get(id);
      return Promise.resolve(
        row && row.projectId === projectId && row.userId === userId ? row : null,
      );
    },
    listForUser: (projectId: string, userId: string) =>
      Promise.resolve(
        [...rows.values()]
          .filter((row) => row.projectId === projectId && row.userId === userId)
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
      ),
    countForProject: (projectId: string) =>
      Promise.resolve([...rows.values()].filter((row) => row.projectId === projectId).length),
    touch: () => Promise.resolve(undefined),
    deleteById: (id: string) => {
      rows.delete(id);
      return Promise.resolve();
    },
    listForRuntime: (runtimeId: string) =>
      Promise.resolve([...rows.values()].filter((row) => row.runtimeId === runtimeId)),
    listIdle: () => Promise.resolve([]),
  } as unknown as TerminalRepository;

  const service = new TerminalSessionService(
    runtimes,
    terminals,
    {
      maxPerProject: options.maxPerProject ?? 5,
      scrollbackBytes: options.scrollbackBytes ?? 1024,
      idleMs: options.idleMs ?? 60_000,
    },
    { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
  );

  return {
    service,
    shells,
    setRuntime: (id: string) => {
      runtimeId = id;
    },
  };
}

describe('opening a shell', () => {
  it('reports itself as new rather than resumed', async () => {
    const { service } = build();
    const attached = await service.attach('p1', 'u1', recordingSocket().socket, {});
    expect(attached).toMatchObject({ resumed: false, replay: '', truncated: false });
    expect(attached.id).not.toHaveLength(0);
  });

  it('sends what the shell prints to whoever is attached', async () => {
    const { service, shells } = build();
    const listener = recordingSocket();
    await service.attach('p1', 'u1', listener.socket, {});

    shells[0]?.emit('hello');
    expect(listener.output).toEqual(['hello']);
  });

  it('appears in the owner list', async () => {
    const { service } = build();
    const attached = await service.attach('p1', 'u1', recordingSocket().socket, {});
    expect(await service.list('p1', 'u1')).toMatchObject([{ id: attached.id, attached: true }]);
  });
});

describe('letting go without ending', () => {
  it('leaves the shell running', async () => {
    const { service, shells } = build();
    const attached = await service.attach('p1', 'u1', recordingSocket().socket, {});

    attached.detach();

    expect(shells[0]?.closed).toBe(false);
    expect(service.openCount).toBe(1);
  });

  it('keeps recording what the shell prints with nobody watching', async () => {
    const { service, shells } = build();
    const first = recordingSocket();
    const attached = await service.attach('p1', 'u1', first.socket, {});
    attached.detach();

    shells[0]?.emit('built in 3.2s\n');
    // Nothing to send it to, and nothing lost either.
    expect(first.output).toEqual([]);

    const second = recordingSocket();
    const resumed = await service.attach('p1', 'u1', second.socket, { sessionId: attached.id });
    expect(resumed.replay).toBe('built in 3.2s\n');
    expect(resumed.resumed).toBe(true);
  });

  it('says so in the list rather than claiming someone is on it', async () => {
    const { service } = build();
    const attached = await service.attach('p1', 'u1', recordingSocket().socket, {});
    attached.detach();
    expect((await service.list('p1', 'u1'))[0]?.attached).toBe(false);
  });
});

describe('resuming', () => {
  it('refuses an identifier that names nothing', async () => {
    const { service } = build();
    await expect(
      service.attach('p1', 'u1', recordingSocket().socket, { sessionId: 'nope' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('refuses a session belonging to someone else', async () => {
    // A session carries one person's working directory, history and
    // half-typed command. Being a member of the project is not permission to
    // watch another member type.
    const { service } = build();
    const attached = await service.attach('p1', 'owner', recordingSocket().socket, {});
    attached.detach();

    await expect(
      service.attach('p1', 'someone-else', recordingSocket().socket, { sessionId: attached.id }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('refuses a session from another project, even to its own owner', async () => {
    const { service } = build();
    const attached = await service.attach('p1', 'u1', recordingSocket().socket, {});
    attached.detach();

    await expect(
      service.attach('p2', 'u1', recordingSocket().socket, { sessionId: attached.id }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('answers the same way whether a session is missing or not yours', async () => {
    // Telling those apart would say whether someone else's session exists.
    const { service } = build();
    const attached = await service.attach('p1', 'owner', recordingSocket().socket, {});
    attached.detach();

    const missing = await service
      .attach('p1', 'u2', recordingSocket().socket, { sessionId: 'absent' })
      .catch((error: unknown) => error);
    const theirs = await service
      .attach('p1', 'u2', recordingSocket().socket, { sessionId: attached.id })
      .catch((error: unknown) => error);

    expect((missing as Error).message).toBe((theirs as Error).message);
  });

  it('hands the shell to the newer socket and tells the older one', async () => {
    const { service, shells } = build();
    const first = recordingSocket();
    const attached = await service.attach('p1', 'u1', first.socket, {});

    const second = recordingSocket();
    await service.attach('p1', 'u1', second.socket, { sessionId: attached.id });

    expect(first.takenOver()).toBe(1);
    // Output now goes to the newer socket only.
    shells[0]?.emit('after');
    expect(first.output).toEqual([]);
    expect(second.output).toEqual(['after']);
  });

  it('does not let the displaced socket detach the session from under the new one', async () => {
    const { service, shells } = build();
    const first = await service.attach('p1', 'u1', recordingSocket().socket, {});
    const second = recordingSocket();
    await service.attach('p1', 'u1', second.socket, { sessionId: first.id });

    // The old socket closes a moment later, as it always does.
    first.detach();

    shells[0]?.emit('still here');
    expect(second.output).toEqual(['still here']);
    expect((await service.list('p1', 'u1'))[0]?.attached).toBe(true);
  });

  it('says the replay is incomplete when the window dropped something', async () => {
    const { service, shells } = build({ scrollbackBytes: 8 });
    const attached = await service.attach('p1', 'u1', recordingSocket().socket, {});
    attached.detach();

    shells[0]?.emit('aaaaaaaa');
    shells[0]?.emit('bbbbbbbb');

    const resumed = await service.attach('p1', 'u1', recordingSocket().socket, {
      sessionId: attached.id,
    });
    expect(resumed.truncated).toBe(true);
    expect(resumed.replay).toBe('bbbbbbbb');
  });
});

describe('ending', () => {
  it('tells the attached socket and forgets the session', async () => {
    const { service, shells } = build();
    const listener = recordingSocket();
    await service.attach('p1', 'u1', listener.socket, {});

    shells[0]?.end(0);

    expect(listener.exits).toEqual([0]);
    expect(service.openCount).toBe(0);
  });

  it('cannot be resumed once the shell has exited', async () => {
    const { service, shells } = build();
    const attached = await service.attach('p1', 'u1', recordingSocket().socket, {});
    shells[0]?.end(0);

    await expect(
      service.attach('p1', 'u1', recordingSocket().socket, { sessionId: attached.id }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('closes the shell when its owner closes the session', async () => {
    const { service, shells } = build();
    const attached = await service.attach('p1', 'u1', recordingSocket().socket, {});

    await service.closeSession(attached.id, 'p1', 'u1');

    expect(shells[0]?.closed).toBe(true);
    expect(service.openCount).toBe(0);
  });

  it('will not let one person close another person session', async () => {
    const { service, shells } = build();
    const attached = await service.attach('p1', 'owner', recordingSocket().socket, {});

    await service.closeSession(attached.id, 'p1', 'someone-else');

    expect(shells[0]?.closed).toBe(false);
    expect(service.openCount).toBe(1);
  });

  it('treats closing something already gone as done, not as an error', async () => {
    const { service } = build();
    await expect(service.closeSession('never-existed', 'p1', 'u1')).resolves.toBeUndefined();
  });
});

describe('shells nobody came back to', () => {
  it('are closed once they have been idle long enough', async () => {
    const { service, shells } = build({ idleMs: 1000 });
    const attached = await service.attach('p1', 'u1', recordingSocket().socket, {});
    attached.detach();

    await service.reapIdle(new Date(Date.now() + 2000));

    expect(shells[0]?.closed).toBe(true);
    expect(service.openCount).toBe(0);
  });

  it('are left alone while somebody is still attached', async () => {
    const { service, shells } = build({ idleMs: 1 });
    await service.attach('p1', 'u1', recordingSocket().socket, {});

    await service.reapIdle(new Date(Date.now() + 60_000));

    expect(shells[0]?.closed).toBe(false);
  });

  it('are left alone before the idle period is up', async () => {
    const { service, shells } = build({ idleMs: 10_000 });
    const attached = await service.attach('p1', 'u1', recordingSocket().socket, {});
    attached.detach();

    await service.reapIdle(new Date(Date.now() + 5_000));

    expect(shells[0]?.closed).toBe(false);
  });
});

describe('the limit', () => {
  it('counts shells rather than sockets', async () => {
    // Counting sockets would let one person open a shell, detach, and repeat,
    // holding processes without ever having more than one window.
    const { service } = build({ maxPerProject: 1 });
    const first = await service.attach('p1', 'u1', recordingSocket().socket, {});
    first.detach();

    await expect(service.attach('p1', 'u1', recordingSocket().socket, {})).rejects.toMatchObject({
      details: { reason: 'too-many-terminals' },
    });
  });

  it('gives the place back when a shell ends', async () => {
    const { service, shells } = build({ maxPerProject: 1 });
    await service.attach('p1', 'u1', recordingSocket().socket, {});
    shells[0]?.end(0);

    await expect(service.attach('p1', 'u1', recordingSocket().socket, {})).resolves.toBeDefined();
  });

  it('is per project, not across the platform', async () => {
    const { service } = build({ maxPerProject: 1 });
    await service.attach('p1', 'u1', recordingSocket().socket, {});
    await expect(service.attach('p2', 'u1', recordingSocket().socket, {})).resolves.toBeDefined();
  });

  it('counts every member shell, because the host pays for all of them', async () => {
    const { service } = build({ maxPerProject: 1 });
    await service.attach('p1', 'u1', recordingSocket().socket, {});
    await expect(service.attach('p1', 'u2', recordingSocket().socket, {})).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
  });
});

describe('a runtime going away', () => {
  it('closes the shells inside it', async () => {
    const { service, shells } = build();
    await service.attach('p1', 'u1', recordingSocket().socket, {});

    await service.releaseRuntime('runtime-1');

    expect(shells[0]?.closed).toBe(true);
    expect(service.openCount).toBe(0);
  });

  it('leaves shells in a different runtime alone', async () => {
    const { service, shells, setRuntime } = build();
    await service.attach('p1', 'u1', recordingSocket().socket, {});
    setRuntime('runtime-2');
    await service.attach('p2', 'u1', recordingSocket().socket, {});

    await service.releaseRuntime('runtime-1');

    expect(shells[0]?.closed).toBe(true);
    expect(shells[1]?.closed).toBe(false);
  });

  it('tells whoever was attached that it ended', async () => {
    const { service } = build();
    const listener = recordingSocket();
    await service.attach('p1', 'u1', listener.socket, {});

    await service.releaseRuntime('runtime-1');

    expect(listener.exits).toEqual([null]);
  });
});

describe('listing', () => {
  it('shows only the caller own shells', async () => {
    const { service } = build();
    await service.attach('p1', 'mine', recordingSocket().socket, {});
    await service.attach('p1', 'theirs', recordingSocket().socket, {});

    expect(await service.list('p1', 'mine')).toHaveLength(1);
  });

  it('shows only shells in the project asked about', async () => {
    const { service } = build();
    await service.attach('p1', 'u1', recordingSocket().socket, {});
    await service.attach('p2', 'u1', recordingSocket().socket, {});

    expect(await service.list('p1', 'u1')).toHaveLength(1);
  });

  it('puts the newest first, because that is the one to come back to', async () => {
    const { service } = build();
    const older = await service.attach('p1', 'u1', recordingSocket().socket, {});
    await new Promise((resolve) => setTimeout(resolve, 5));
    const newer = await service.attach('p1', 'u1', recordingSocket().socket, {});

    expect((await service.list('p1', 'u1')).map((s: { id: string }) => s.id)).toEqual([
      newer.id,
      older.id,
    ]);
  });

  it('is empty for a project with nothing open', async () => {
    const { service } = build();
    expect(await service.list('p1', 'u1')).toEqual([]);
  });
});

describe('shutting down', () => {
  it('closes every shell rather than leaving them in containers', async () => {
    const { service, shells } = build();
    await service.attach('p1', 'u1', recordingSocket().socket, {});
    await service.attach('p2', 'u2', recordingSocket().socket, {});

    await service.closeAll();

    expect(shells.every((shell) => shell.closed)).toBe(true);
    expect(service.openCount).toBe(0);
  });
});
