import { pino } from 'pino';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
  createDockerClient,
  DockerExecutionProvider,
} from '../src/execution/docker/docker-provider.js';
import type { ExecutionHandle, ProcessOutput } from '../src/execution/provider.js';

/**
 * A real program, started and stopped inside a real container.
 *
 * Docker can start an exec and cannot stop one, so the platform records the
 * process id inside the container and signals it. Everything in this file is
 * about whether that actually works: whether the recorded id is the program's
 * own, whether a signal reaches the children it spawned, and whether the
 * platform can still tell afterwards.
 */

const docker = createDockerClient(process.env.DOCKER_SOCKET_PATH);
const reachable = await docker
  .ping()
  .then(() => true)
  .catch(() => false);

const IMAGE = 'alpine:3.20';
const NETWORK = 'platform-runtimes-run-test';

const provider = new DockerExecutionProvider(
  docker,
  {
    workspacePath: '/workspace',
    networkPrefix: NETWORK,
    terminalReplayBytes: 64 * 1024,
    hardening: {
      // Set TEST_OCI_RUNTIME=runsc to run this suite under gVisor.
      ociRuntime: process.env.TEST_OCI_RUNTIME ?? null,
      maxOpenFiles: 8_192,
      maxProcesses: 128,
      workloadUser: '1000:1000',
      homePath: '/home/workload',
      tmpMegabytes: 256,
    },
    pullTimeoutMs: 300_000,
    availabilityTtlMs: 0,
    read: {
      maxFileBytes: 1_000_000,
      maxTotalBytes: 10_000_000,
      maxFiles: 1_000,
      applyExclusions: true,
    },
    collect: {
      maxFileBytes: 1_000_000,
      maxTotalBytes: 10_000_000,
      maxFiles: 1_000,
      applyExclusions: false,
    },
  },
  pino({ level: 'silent' }),
);

let counter = 0;
const started: ExecutionHandle[] = [];

async function runningWorkload(): Promise<ExecutionHandle> {
  counter += 1;
  const handle = await provider.create({
    kind: 'runtime' as const,
    workloadId: `run-${process.pid}-${counter}`,
    projectId: '018f0000-0000-7000-8000-0000000000aa',
    image: IMAGE,
    limits: { cpuMillicores: 500, memoryMb: 256, pidsLimit: 64 },
    env: {},
  });
  started.push(handle);
  await provider.start(handle);
  return handle;
}

/** Starts a program and collects what it prints. */
async function run(handle: ExecutionHandle, command: string, env?: Record<string, string>) {
  const process = await provider.startProcess(handle, { command, ...(env ? { env } : {}) });

  const seen: ProcessOutput[] = [];
  let exitCode: number | null | undefined;

  process.onOutput((output) => seen.push(output));
  process.onExit((code) => {
    exitCode = code;
  });

  return {
    process,
    text: (stream?: 'stdout' | 'stderr') =>
      seen
        .filter((output) => !stream || output.stream === stream)
        .map((output) => Buffer.from(output.chunk).toString('utf8'))
        .join(''),
    exitCode: () => exitCode,
    /** Waits for a condition, or gives up. */
    async until(check: () => boolean, timeoutMs = 15_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (check()) return true;
        await delay(100);
      }
      return false;
    },
  };
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs a command in the container without going through the provider.
 *
 * Checking has to leave the thing being checked alone: starting a process
 * through the provider rewrites the recorded process id, which is exactly what
 * some of these tests are asserting about.
 */
async function inspect(handle: ExecutionHandle, command: string): Promise<string> {
  const exec = await docker.getContainer(handle.externalId).exec({
    Cmd: ['/bin/sh', '-c', command],
    AttachStdout: true,
    AttachStderr: true,
    Tty: true,
  });
  const stream = await exec.start({ hijack: true, stdin: false });

  return new Promise<string>((resolve) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    stream.on('error', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

describe.skipIf(!reachable)('running a program in a container', () => {
  afterEach(async () => {
    while (started.length > 0) {
      await provider.destroy(started.pop()!).catch(() => undefined);
    }
  });

  afterAll(async () => {
    // One network per project since task 53; the old single name matched
    // nothing, so every run leaked one.
    for (const network of await provider.listNetworks().catch(() => [])) {
      if (network.name.startsWith(NETWORK)) {
        await provider.removeNetwork(network.id).catch(() => undefined);
      }
    }
  });

  describe('output', () => {
    it('carries what the program printed', async () => {
      const handle = await runningWorkload();
      const running = await run(handle, 'echo hello-from-the-program');

      expect(await running.until(() => running.text().includes('hello-from-the-program'))).toBe(
        true,
      );
    });

    it('keeps errors apart from ordinary output', async () => {
      // The whole reason for running without a terminal. With one, Docker
      // merges the two and nobody can tell a failure from a log line.
      const handle = await runningWorkload();
      const running = await run(handle, 'echo to-out; echo to-err >&2');

      await running.until(() => running.text('stderr').includes('to-err'));

      expect(running.text('stdout')).toContain('to-out');
      expect(running.text('stdout')).not.toContain('to-err');
      expect(running.text('stderr')).toContain('to-err');
    });

    it('carries characters that are not ASCII', async () => {
      const handle = await runningWorkload();
      const running = await run(handle, 'echo "héllo wörld"');

      expect(await running.until(() => running.text().includes('héllo wörld'))).toBe(true);
    });

    it('reports the exit code', async () => {
      const handle = await runningWorkload();
      const running = await run(handle, 'exit 3');

      expect(await running.until(() => running.exitCode() !== undefined)).toBe(true);
      expect(running.exitCode()).toBe(3);
    });

    it('reports the exit code to whoever asks after it happened', async () => {
      /*
       * A program that ends in milliseconds ends before anything has had a
       * chance to listen. Only queueing listeners would drop that exit
       * entirely, and a dropped exit leaves the platform saying a program is
       * running until something else notices it is not.
       */
      const handle = await runningWorkload();
      const started = await provider.startProcess(handle, { command: 'exit 7' });

      await new Promise((resolve) => setTimeout(resolve, 2_000));

      const code = await new Promise<number | null>((resolve) => {
        started.onExit(resolve);
        setTimeout(() => resolve(-1), 10_000);
      });

      expect(code).toBe(7);
    });

    it('reports a clean exit as zero', async () => {
      const handle = await runningWorkload();
      const running = await run(handle, 'true');

      await running.until(() => running.exitCode() !== undefined);
      expect(running.exitCode()).toBe(0);
    });
  });

  describe('the environment it runs in', () => {
    it('runs in the workspace', async () => {
      const handle = await runningWorkload();
      await provider.seedWorkspace(handle, [
        { path: 'marker.txt', content: new TextEncoder().encode('here') },
      ]);

      const running = await run(handle, 'pwd; cat marker.txt');

      expect(await running.until(() => running.text().includes('here'))).toBe(true);
      expect(running.text()).toContain('/workspace');
    });

    it('receives the environment it was given', async () => {
      const handle = await runningWorkload();
      const running = await run(handle, 'echo "token is $API_TOKEN"', { API_TOKEN: 'sk-live-abc' });

      expect(await running.until(() => running.text().includes('sk-live-abc'))).toBe(true);
    });
  });

  describe('stopping', () => {
    it('reports a long-running program as running', async () => {
      const handle = await runningWorkload();
      await run(handle, 'while true; do sleep 1; done');
      await delay(500);

      expect(await provider.processRunning(handle)).toBe(true);
    });

    it('stops it', async () => {
      const handle = await runningWorkload();
      await run(handle, 'while true; do sleep 1; done');
      await delay(500);

      await provider.stopProcess(handle, 5);

      expect(await provider.processRunning(handle)).toBe(false);
    });

    it('stops the children a command spawned, not only the command', async () => {
      /*
       * The case that makes the naive version wrong. A shell that starts a
       * server in the background and waits is exactly what `npm start` looks
       * like: signalling the shell alone leaves the server holding the port.
       *
       * The child is identified by an unusual sleep duration rather than by a
       * recorded process id, because capturing one through three layers of
       * quoting is how the first version of this test came to assert nothing.
       */
      const handle = await runningWorkload();
      await run(handle, 'sleep 987 & wait');
      await delay(800);

      expect(await inspect(handle, 'ps -o args')).toContain('sleep 987');

      await provider.stopProcess(handle, 5);
      await delay(400);

      expect(await inspect(handle, 'ps -o args')).not.toContain('sleep 987');
    });

    it('treats stopping nothing as already done', async () => {
      const handle = await runningWorkload();
      await expect(provider.stopProcess(handle, 5)).resolves.toBeUndefined();
    });

    it('reports a program that ended on its own as not running', async () => {
      const handle = await runningWorkload();
      const running = await run(handle, 'true');
      await running.until(() => running.exitCode() !== undefined);

      expect(await provider.processRunning(handle)).toBe(false);
    });

    it('leaves nothing behind that a later stop could signal', async () => {
      // A stale process id could be reused by the kernel, and the next stop
      // would then signal an unrelated process.
      const handle = await runningWorkload();
      const running = await run(handle, 'true');
      await running.until(() => running.exitCode() !== undefined);
      await provider.stopProcess(handle, 5);

      const answer = await inspect(
        handle,
        'if [ -f /tmp/.platform-run.pid ]; then echo yes; else echo no; fi',
      );

      expect(answer).toContain('no');
    });
  });

  describe('detaching', () => {
    it('stops watching without stopping the program', async () => {
      // A control plane that restarts must be able to let go. The program
      // belongs to the container, not to the connection watching it.
      const handle = await runningWorkload();
      const running = await run(handle, 'while true; do sleep 1; done');
      await delay(500);

      await running.process.detach();
      await delay(300);

      expect(await provider.processRunning(handle)).toBe(true);
    });
  });

  describe('starting again', () => {
    it('replaces the previous program rather than counting two', async () => {
      const handle = await runningWorkload();
      await run(handle, 'while true; do sleep 1; done');
      await delay(400);
      await provider.stopProcess(handle, 5);

      const second = await run(handle, 'echo second-run');

      expect(await second.until(() => second.text().includes('second-run'))).toBe(true);
    });
  });
});
