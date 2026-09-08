import type { Duplex } from 'node:stream';
import type Docker from 'dockerode';
import type { TerminalSize } from '@platform/shared';
import { AppError } from '../../errors/app-error.js';
import type { ExecutionHandle, TerminalOptions, TerminalSession } from '../provider.js';

/**
 * An interactive shell inside a running container.
 *
 * Docker's exec with a TTY allocates a real pseudo-terminal in the container,
 * which is what makes line editing, job control, colour and the shell's own
 * prompt work. Without it a person is typing into a pipe and everything above
 * feels broken in ways that are hard to describe.
 *
 * The shell is chosen here rather than by the caller. `/bin/sh` exists in every
 * image in the catalogue, and a caller that could name the program would be one
 * argument away from naming one on the host.
 */

const SHELL = ['/bin/sh'];

/**
 * Environment for the shell.
 *
 * `TERM` matters: without it the shell assumes a dumb terminal and refuses to
 * emit the escape sequences the browser is ready to render.
 */
const TERMINAL_ENV = ['TERM=xterm-256color'];

export async function openDockerTerminal(
  docker: Docker,
  handle: ExecutionHandle,
  options: TerminalOptions,
  /**
   * Who the shell belongs to.
   *
   * A terminal is the most direct way somebody runs code in this platform, so
   * it is the exec that matters most: leaving it as root would hand back
   * everything running the container unprivileged was for.
   */
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

    // Hijacked, so the socket becomes a raw bidirectional stream. With a TTY
    // Docker sends output unframed, which is why nothing here demultiplexes.
    stream = (await exec.start({ hijack: true, stdin: true })) as unknown as Duplex;
  } catch (error) {
    throw new AppError('EXECUTION_FAILED', 'A terminal could not be opened for this project.', {
      expose: true,
      cause: error,
      context: { containerId: handle.externalId },
    });
  }

  // Set before the first write, so the shell's first prompt is drawn at the
  // width the person is actually looking at.
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
        // Asked after the stream ends, because that is when Docker knows it.
        // A code it cannot give is reported as unknown rather than as zero,
        // which would read as success.
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
      // Destroying the hijacked socket is what ends the exec: there is no
      // "stop this exec" call, and the process dies with its terminal.
      stream.destroy();
      return Promise.resolve();
    },
  };

  return session;
}

async function resize(exec: Docker.Exec, size: TerminalSize): Promise<void> {
  await exec.resize({ h: size.rows, w: size.columns });
}
