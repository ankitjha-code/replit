import type { Duplex } from 'node:stream';
import type Docker from 'dockerode';
import type { TerminalSize } from '@platform/shared';
import { AppError } from '../../errors/app-error.js';
import type { ExecutionHandle, TerminalOptions, TerminalSession } from '../provider.js';
import { createDemultiplexer } from './docker-process.js';
import { SHELL_PROMPT } from './docker-terminal.js';

function paths(terminalId: string) {
  const dir = `/tmp/.platform-terminals/${terminalId}`;
  return { dir, pipe: `${dir}/in`, log: `${dir}/out.log`, pid: `${dir}/pid`, tty: `${dir}/tty` };
}

function assertTerminalId(terminalId: string): void {
  if (!/^[a-zA-Z0-9-]{1,64}$/.test(terminalId)) {
    throw new AppError('EXECUTION_FAILED', 'A terminal could not be opened for this project.', {
      expose: true,
      context: { terminalId, problem: 'not a platform identifier' },
    });
  }
}

function sizeOf(size: TerminalSize): string {
  return `rows ${String(Math.max(1, Math.floor(size.rows)))} cols ${String(
    Math.max(1, Math.floor(size.columns)),
  )}`;
}

export async function startDetachedTerminal(
  docker: Docker,
  handle: ExecutionHandle,
  terminalId: string,
  options: TerminalOptions & { user: string | null; home: string },
): Promise<void> {
  assertTerminalId(terminalId);

  const { dir, pipe, log, pid, tty } = paths(terminalId);
  const cwd = options.cwd ?? '.';

  const inner = `tty > '${tty}'; stty ${sizeOf(options.size)} 2>/dev/null; exec /bin/sh -i`;

  const script = [
    `command -v script >/dev/null 2>&1 || { echo missing-script; exit 0; }`,
    `mkdir -p '${dir}'`,
    `rm -f '${pipe}' '${log}' '${pid}' '${tty}'`,
    `mkfifo '${pipe}'`,
    `: > '${log}'`,
    `cd '${cwd}' 2>/dev/null || true`,
    `setsid script -q -f -c "${inner}" '${log}' <>'${pipe}' >/dev/null 2>&1 & echo $! > '${pid}'`,
    `sleep 1`,
    `kill -0 "$(cat '${pid}')" 2>/dev/null && echo started || echo failed`,
  ].join('\n');

  const output = await runToCompletion(docker, handle, script, options.user, {
    TERM: 'xterm-256color',
    HOME: options.home,
    PS1: SHELL_PROMPT,
  });

  if (!output.includes('started')) {
    throw new AppError(
      'EXECUTION_FAILED',
      'A terminal that survives a restart could not be started in this environment.',
      {
        expose: true,
        context: {
          terminalId,
          reason: output.includes('missing-script') ? 'no script in image' : 'did not start',
        },
      },
    );
  }
}

export async function attachDetachedTerminal(
  docker: Docker,
  handle: ExecutionHandle,
  terminalId: string,
  identity: { user: string | null; home: string; replayBytes: number },
): Promise<TerminalSession> {
  assertTerminalId(terminalId);

  const { pipe, log, tty } = paths(terminalId);
  const container = docker.getContainer(handle.externalId);

  let exec: Docker.Exec;
  let stream: Duplex;

  try {
    exec = await container.exec({
      Cmd: [
        '/bin/sh',
        '-c',
        `tail -c ${String(identity.replayBytes)} -f '${log}' & exec cat >> '${pipe}'`,
      ],
      ...(identity.user ? { User: identity.user } : {}),
      Env: [`HOME=${identity.home}`],
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
    });

    stream = (await exec.start({ hijack: true, stdin: true })) as unknown as Duplex;
  } catch (error) {
    throw new AppError('EXECUTION_FAILED', 'That terminal could not be reattached.', {
      expose: true,
      cause: error,
      context: { containerId: handle.externalId, terminalId },
    });
  }

  let closed = false;
  const listeners: ((chunk: Uint8Array) => void)[] = [];
  const exits: ((code: number | null) => void)[] = [];

  const early: Uint8Array[] = [];

  const demultiplex = createDemultiplexer(({ chunk }) => {
    if (listeners.length === 0) {
      early.push(chunk);
      return;
    }
    for (const listener of listeners) listener(chunk);
  });
  stream.on('data', (chunk: Buffer) => demultiplex(chunk));

  const finish = (): void => {
    if (closed) return;
    closed = true;
    for (const listener of exits) listener(null);
  };

  stream.on('end', finish);
  stream.on('close', finish);
  stream.on('error', finish);

  return {
    onData(listener) {
      listeners.push(listener);
      if (listeners.length === 1) {
        for (const chunk of early.splice(0)) listener(chunk);
      }
    },
    onExit(listener) {
      exits.push(listener);
    },
    write(data) {
      if (!closed) stream.write(data);
    },
    async resize(size) {
      await runToCompletion(
        docker,
        handle,
        `stty -F "$(cat '${tty}')" ${sizeOf(size)} 2>/dev/null || true`,
        identity.user,
        {},
      ).catch(() => undefined);
    },
    async close() {
      closed = true;
      stream.end();
      stream.destroy();
      await Promise.resolve();
    },
  };
}

export async function stopDetachedTerminal(
  docker: Docker,
  handle: ExecutionHandle,
  terminalId: string,
  user: string | null,
): Promise<void> {
  assertTerminalId(terminalId);

  const { dir, pid } = paths(terminalId);

  const script = [
    `if [ -f '${pid}' ]; then kill -TERM "$(cat '${pid}')" 2>/dev/null || true; fi`,
    `sleep 1`,
    `if [ -f '${pid}' ]; then kill -KILL "$(cat '${pid}')" 2>/dev/null || true; fi`,
    `rm -rf '${dir}'`,
  ].join('\n');

  await runToCompletion(docker, handle, script, user, {}).catch(() => undefined);
}

export async function detachedTerminalRunning(
  docker: Docker,
  handle: ExecutionHandle,
  terminalId: string,
  user: string | null,
): Promise<boolean> {
  assertTerminalId(terminalId);

  const { pid } = paths(terminalId);
  const output = await runToCompletion(
    docker,
    handle,
    `if [ -f '${pid}' ] && kill -0 "$(cat '${pid}')" 2>/dev/null; then echo yes; else echo no; fi`,
    user,
    {},
  ).catch(() => 'no');

  return output.includes('yes');
}

async function runToCompletion(
  docker: Docker,
  handle: ExecutionHandle,
  script: string,
  user: string | null,
  env: Record<string, string>,
): Promise<string> {
  const exec = await docker.getContainer(handle.externalId).exec({
    Cmd: ['/bin/sh', '-c', script],
    ...(user ? { User: user } : {}),
    Env: Object.entries(env).map(([key, value]) => `${key}=${value}`),
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
  });

  const stream = (await exec.start({ hijack: true, stdin: false })) as unknown as Duplex;

  return new Promise<string>((resolve) => {
    let text = '';
    const demultiplex = createDemultiplexer(({ chunk }) => {
      text += Buffer.from(chunk).toString('utf8');
    });
    stream.on('data', (chunk: Buffer) => demultiplex(chunk));
    stream.on('end', () => resolve(text));
    stream.on('close', () => resolve(text));
    stream.on('error', () => resolve(text));
  });
}
