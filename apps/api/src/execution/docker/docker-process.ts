import type { Duplex } from 'node:stream';
import type Docker from 'dockerode';
import { AppError } from '../../errors/app-error.js';
import type {
  ExecutionHandle,
  ProcessOutput,
  RunningProcess,
  StartProcessOptions,
} from '../provider.js';

const PID_FILE = '/tmp/.platform-run.pid';

const HEADER_BYTES = 8;
const STDERR_STREAM = 2;

export interface ExecIdentity {
  user: string | null;
  home: string;
}

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

  await runSilently(docker, handle, `rm -f ${PID_FILE}`, identity);

  let exec: Docker.Exec;
  let stream: Duplex;

  try {
    exec = await container.exec({
      Cmd: ['/bin/sh', '-c', wrapper(options.command)],
      ...identityOf(identity),
      Env: [
        ...Object.entries(options.env ?? {}).map(([key, value]) => `${key}=${value}`),
        ...(identity ? [`HOME=${identity.home}`] : []),
      ],
      AttachStdout: true,
      AttachStderr: true,
      AttachStdin: false,
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
      if (exit) {
        listener(exit.code);
        return;
      }
      exitListeners.push(listener);
    },
    detach() {
      ended = true;
      stream.destroy();
      return Promise.resolve();
    },
  };
}

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
  const output = await runSilently(
    docker,
    handle,
    `if [ -f ${PID_FILE} ] && kill -0 "$(cat ${PID_FILE})" 2>/dev/null; then echo yes; else echo no; fi`,
    identity,
  );
  return output.includes('yes');
}

function wrapper(command: string): string {
  return `echo $$ > ${PID_FILE}; ${command}`;
}

function signalScript(signal: 'TERM' | 'KILL'): string {
  return [
    `pid="$(cat ${PID_FILE} 2>/dev/null)"`,
    '[ -n "$pid" ] || exit 0',
    `kill -${signal} -"$pid" 2>/dev/null || kill -${signal} "$pid" 2>/dev/null || true`,
  ].join('; ');
}

async function runSilently(
  docker: Docker,
  handle: ExecutionHandle,
  script: string,
  identity?: ExecIdentity,
): Promise<string> {
  try {
    const exec = await docker.getContainer(handle.externalId).exec({
      Cmd: ['/bin/sh', '-c', script],
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
    return '';
  }
}

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
