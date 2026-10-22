import type { Duplex } from 'node:stream';
import type Docker from 'dockerode';
import type { TerminalSize } from '@platform/shared';
import { AppError } from '../../errors/app-error.js';
import type { ExecutionHandle, TerminalOptions, TerminalSession } from '../provider.js';

const SHELL = ['/bin/sh'];

export const SHELL_PROMPT = '$PWD $ ';

const TERMINAL_ENV = ['TERM=xterm-256color', `PS1=${SHELL_PROMPT}`];

export async function openDockerTerminal(
  docker: Docker,
  handle: ExecutionHandle,
  options: TerminalOptions,
  identity?: { user: string | null; home: string },
): Promise<TerminalSession> {
  const container = docker.getContainer(handle.externalId);

  let exec: Docker.Exec;
  let stream: Duplex;

  try {
    exec = await container.exec({
      Cmd: SHELL,
      ...(identity?.user ? { User: identity.user } : {}),
      Env: [...TERMINAL_ENV, ...(identity ? [`HOME=${identity.home}`] : [])],
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
      ...(options.cwd === undefined ? {} : { WorkingDir: options.cwd }),
    });

    stream = (await exec.start({ hijack: true, stdin: true })) as unknown as Duplex;
  } catch (error) {
    throw new AppError('EXECUTION_FAILED', 'A terminal could not be opened for this project.', {
      expose: true,
      cause: error,
      context: { containerId: handle.externalId },
    });
  }

  await resize(exec, options.size).catch(() => undefined);

  let closed = false;

  const session: TerminalSession = {
    onData(listener) {
      stream.on('data', (chunk: Buffer) => listener(chunk));
    },

    onExit(listener) {
      const finish = async () => {
        if (closed) return;
        closed = true;
        const code = await exec
          .inspect()
          .then((info) => info.ExitCode ?? null)
          .catch(() => null);
        listener(code);
      };

      stream.on('end', () => void finish());
      stream.on('close', () => void finish());
      stream.on('error', () => void finish());
    },

    write(data) {
      if (closed || stream.destroyed) return;
      stream.write(data);
    },

    resize(size) {
      return resize(exec, size);
    },

    close() {
      closed = true;
      stream.destroy();
      return Promise.resolve();
    },
  };

  return session;
}

async function resize(exec: Docker.Exec, size: TerminalSize): Promise<void> {
  await exec.resize({ h: size.rows, w: size.columns });
}
