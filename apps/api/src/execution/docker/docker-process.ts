import type { Duplex } from 'node:stream';
import type Docker from 'dockerode';
import { AppError } from '../../errors/app-error.js';
import type {
  ExecutionHandle,
  ProcessOutput,
  RunningProcess,
  StartProcessOptions,
} from '../provider.js';

/**
 * The project's own application, running inside its container.
 *
 * Deliberately not the container's main process. The container has to stay up
 * whether or not the application is healthy: a crashed program is exactly when
 * someone needs a terminal in there, a look at the files, and the output that
 * explains it. Making the application the container would take all three away
 * at the moment they matter most.
 *
 * That leaves one problem. Docker can start an exec and cannot stop one: there
 * is no API for it. So the wrapper below records its own process id in the
 * container before handing itself over to the command, and stopping is a
 * second exec that signals that id. `exec` in the shell means the recorded id
 * belongs to the application itself rather than to a shell that started it,
 * which is what makes the signal land on the right process.
 */

/** Where the running application records its process id, inside the container. */
const PID_FILE = '/tmp/.platform-run.pid';

/**
 * Docker frames the output of an exec without a terminal: eight bytes of
 * header, then the payload. The first byte says which stream it came from.
 */
const HEADER_BYTES = 8;
const STDERR_STREAM = 2;

/**
 * Who the platform's own execs run as, and where their home is.
 *
 * Threaded through rather than read from configuration here, because this file
 * knows how to talk to a container and not what an installation has decided.
 * Undefined means root, which is what an installation that has turned the
 * measure off has.
 */
export interface ExecIdentity {
  user: string | null;
  home: string;
}

/**
 * Applied to every exec, without exception.
 *
 * The container already runs as this user, so leaving it off an exec would
 * silently hand root back for exactly the commands that run somebody else's
 * code — which is the only thing the whole measure is about.
 */
function identityOf(identity: ExecIdentity | undefined): { User?: string } {
  return identity?.user ? { User: identity.user } : {};
}

export async function startDockerProcess(
  docker: Docker,
  handle: ExecutionHandle,
  options: StartProcessOptions,
  identity?: ExecIdentity,
): Promise<RunningProcess> {
  const container = docker.getContainer(handle.externalId);

  // Anything left from a previous run would otherwise be signalled by the next
  // stop, which could land on a process id the kernel has since reused.
  await runSilently(docker, handle, `rm -f ${PID_FILE}`, identity);

  let exec: Docker.Exec;
  let stream: Duplex;

  try {
    exec = await container.exec({
      Cmd: ['/bin/sh', '-c', wrapper(options.command)],
      ...identityOf(identity),
      Env: [
        ...Object.entries(options.env ?? {}).map(([key, value]) => `${key}=${value}`),
        // Last, so a project cannot point HOME at something it cannot write and
        // then report that installing a dependency is broken.
        ...(identity ? [`HOME=${identity.home}`] : []),
      ],
      AttachStdout: true,
      AttachStderr: true,
      AttachStdin: false,
      // No terminal. With one, Docker merges the streams and a person could
      // not tell an error from ordinary output.
      Tty: false,
      ...(options.cwd === undefined ? {} : { WorkingDir: options.cwd }),
    });

    stream = (await exec.start({ hijack: true, stdin: false })) as unknown as Duplex;
  } catch (error) {
    throw new AppError('EXECUTION_FAILED', 'The application could not be started.', {
      expose: true,
      cause: error,
      context: { containerId: handle.externalId },
    });
  }

  let ended = false;
  /** Set once the program has finished and its code is known. */
  let exit: { code: number | null } | undefined;
  const outputListeners: ((output: ProcessOutput) => void)[] = [];
  const exitListeners: ((code: number | null) => void)[] = [];

  const demultiplex = createDemultiplexer((output) => {
    for (const listener of outputListeners) listener(output);
  });

  stream.on('data', (chunk: Buffer) => demultiplex(chunk));

  const finish = async (): Promise<void> => {
    if (ended) return;
    ended = true;

    // Asked after the stream ends, because that is when Docker knows it. A
    // code it cannot give is reported as unknown rather than as zero, which
    // would read as success.
    const code = await exec
      .inspect()
      .then((info) => info.ExitCode ?? null)
      .catch(() => null);

    exit = { code };
    for (const listener of exitListeners) listener(code);
  };

  stream.on('end', () => void finish());
  stream.on('close', () => void finish());
  stream.on('error', () => void finish());

  return {
    onOutput(listener) {
      outputListeners.push(listener);
    },
    onExit(listener) {
      /*
       * Told at once when the program has already finished.
       *
       * A command that ends in milliseconds ends before the caller has had a
       * chance to ask about it. Only queuing the listener would lose that
       * exit, and losing it means the platform goes on saying a program is
       * running until something else notices it is not.
       */
      if (exit) {
        listener(exit.code);
        return;
      }
      exitListeners.push(listener);
    },
    detach() {
      // Destroys the socket watching the program, not the program. The exec
      // keeps running inside the container with nothing attached to it.
      ended = true;
      stream.destroy();
      return Promise.resolve();
    },
  };
}

/**
 * Signals the running application, then forces it.
 *
 * Succeeds when nothing is running: that is the state being asked for, and
 * reconciliation after a restart depends on being able to ask for it.
 */
export async function stopDockerProcess(
  docker: Docker,
  handle: ExecutionHandle,
  graceSeconds: number,
  identity?: ExecIdentity,
): Promise<void> {
  const running = await dockerProcessRunning(docker, handle, identity);
  if (!running) {
    await runSilently(docker, handle, `rm -f ${PID_FILE}`, identity);
    return;
  }

  /*
   * The whole process group, not only the recorded process.
   *
   * A command like `npm start` spawns the real server as a child, and
   * signalling only the parent leaves the child holding the port. The negative
   * process id is what makes the signal reach the group, which the wrapper
   * created by starting a new session.
   */
  await runSilently(docker, handle, signalScript('TERM'), identity);

  const deadline = Date.now() + graceSeconds * 1000;
  while (Date.now() < deadline) {
    if (!(await dockerProcessRunning(docker, handle, identity))) {
      await runSilently(docker, handle, `rm -f ${PID_FILE}`, identity);
      return;
    }
    await delay(200);
  }

  await runSilently(docker, handle, signalScript('KILL'), identity);
  await runSilently(docker, handle, `rm -f ${PID_FILE}`, identity);
}

export async function dockerProcessRunning(
  docker: Docker,
  handle: ExecutionHandle,
  identity?: ExecIdentity,
): Promise<boolean> {
  // `kill -0` signals nothing and reports whether it could have.
  const output = await runSilently(
    docker,
    handle,
    `if [ -f ${PID_FILE} ] && kill -0 "$(cat ${PID_FILE})" 2>/dev/null; then echo yes; else echo no; fi`,
    identity,
  );
  return output.includes('yes');
}

/**
 * The shell that starts the application.
 *
 * Two things this deliberately does not do, both learned by watching a real
 * container rather than by reasoning about one.
 *
 * It does not use `exec` to replace the shell with the command. `exec` takes a
 * single simple command, so anything real broke: `a; b` ran only `a`, `a && b`
 * changed meaning, and `if ...; then ...; fi` was a syntax error.
 *
 * It does not use `setsid` to make a new process group either. BusyBox's
 * `setsid` forks and its parent returns immediately, which threw away the exit
 * code: a command that failed with 3 was reported as 0. It turns out not to be
 * needed, because a container runtime already starts each exec in its own
 * process group, so the shell recorded below is a group leader and everything
 * it spawns joins that group.
 */
function wrapper(command: string): string {
  return `echo $$ > ${PID_FILE}; ${command}`;
}

/**
 * Signals the group if there is one, and the process itself otherwise.
 *
 * The group is what matters: `npm start` runs the real server as a child, and
 * signalling the parent alone leaves the child holding the port. The fallback
 * covers a container runtime that does not give each exec its own group, where
 * the negative signal fails rather than reaching something unrelated.
 */
function signalScript(signal: 'TERM' | 'KILL'): string {
  return [
    `pid="$(cat ${PID_FILE} 2>/dev/null)"`,
    '[ -n "$pid" ] || exit 0',
    `kill -${signal} -"$pid" 2>/dev/null || kill -${signal} "$pid" 2>/dev/null || true`,
  ].join('; ');
}

/**
 * Runs a short command in the container and returns what it printed.
 *
 * Used only for the platform's own bookkeeping: recording, signalling and
 * checking a process id. Never for anything a person supplied.
 */
async function runSilently(
  docker: Docker,
  handle: ExecutionHandle,
  script: string,
  identity?: ExecIdentity,
): Promise<string> {
  try {
    const exec = await docker.getContainer(handle.externalId).exec({
      Cmd: ['/bin/sh', '-c', script],
      /*
       * As the workload, not as root.
       *
       * These commands touch files the workload created — the recorded process
       * id — and signal processes the workload owns. Running them as root would
       * work and would mean the platform could signal anything in the container,
       * which is more than it needs in order to stop what it started.
       */
      ...identityOf(identity),
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
    });

    const stream = (await exec.start({ hijack: true, stdin: false })) as unknown as Duplex;

    return await new Promise<string>((resolve) => {
      let text = '';
      const demultiplex = createDemultiplexer((output) => {
        text += Buffer.from(output.chunk).toString('utf8');
      });

      stream.on('data', (chunk: Buffer) => demultiplex(chunk));
      stream.on('end', () => resolve(text));
      stream.on('close', () => resolve(text));
      stream.on('error', () => resolve(text));
    });
  } catch {
    // The container may have gone. Every caller here is asking a question
    // whose honest answer in that case is "nothing".
    return '';
  }
}

/**
 * Splits Docker's framed stream into the two streams it carries.
 *
 * A frame's header can arrive split across chunks, and a payload can arrive in
 * pieces, so both are buffered until there is enough to be sure.
 */
export function createDemultiplexer(emit: (output: ProcessOutput) => void) {
  let buffer: Buffer = Buffer.alloc(0);

  return (chunk: Buffer): void => {
    buffer = Buffer.concat([buffer, chunk]);

    while (buffer.length >= HEADER_BYTES) {
      const size = buffer.readUInt32BE(4);
      if (buffer.length < HEADER_BYTES + size) return;

      const stream = buffer.readUInt8(0) === STDERR_STREAM ? 'stderr' : 'stdout';
      const payload = buffer.subarray(HEADER_BYTES, HEADER_BYTES + size);

      if (size > 0) emit({ stream, chunk: Uint8Array.from(payload) });
      buffer = buffer.subarray(HEADER_BYTES + size);
    }
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
