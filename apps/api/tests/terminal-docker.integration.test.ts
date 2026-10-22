import { pino } from 'pino';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
  createDockerClient,
  DockerExecutionProvider,
} from '../src/execution/docker/docker-provider.js';
import type { ExecutionHandle, TerminalSession } from '../src/execution/provider.js';

const docker = createDockerClient(process.env.DOCKER_SOCKET_PATH);
const reachable = await docker
  .ping()
  .then(() => true)
  .catch(() => false);

const IMAGE = 'alpine:3.20';
const NETWORK = 'platform-runtimes-terminal-test';

const provider = new DockerExecutionProvider(
  docker,
  {
    workspacePath: '/workspace',
    networkPrefix: NETWORK,
    terminalReplayBytes: 64 * 1024,
    hardening: {
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
const sessions: TerminalSession[] = [];

async function runningWorkload(image = IMAGE): Promise<ExecutionHandle> {
  counter += 1;
  const handle = await provider.create({
    kind: 'runtime' as const,
    workloadId: `terminal-${process.pid}-${counter}`,
    projectId: '018f0000-0000-7000-8000-0000000000aa',
    image,
    limits: { cpuMillicores: 500, memoryMb: 256, pidsLimit: 64 },
    env: {},
  });
  started.push(handle);
  await provider.start(handle);
  return handle;
}

async function terminal(handle: ExecutionHandle, columns = 80, rows = 24) {
  const session = await provider.openTerminal(handle, { size: { columns, rows } });
  sessions.push(session);

  let output = '';
  session.onData((chunk) => {
    output += Buffer.from(chunk).toString('utf8');
  });

  return {
    session,
    output: () => output,
    async run(command: string, expected: RegExp, timeoutMs = 10_000) {
      const before = output.length;
      session.write(`${command}\n`);

      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const since = output.slice(before);
        if (expected.test(since)) return since;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error(
        `never matched ${String(expected)} in: ${JSON.stringify(output.slice(before))}`,
      );
    },
  };
}

describe.skipIf(!reachable)('a shell inside a container', () => {
  afterEach(async () => {
    while (sessions.length > 0) await sessions.pop()!.close();
    while (started.length > 0) {
      await provider.destroy(started.pop()!).catch(() => undefined);
    }
  });

  afterAll(async () => {
    for (const network of await provider.listNetworks().catch(() => [])) {
      if (network.name.startsWith(NETWORK)) {
        await provider.removeNetwork(network.id).catch(() => undefined);
      }
    }
  });

  it('the durable terminal is a real pseudo-terminal, under any runtime', async () => {
    const handle = await runningWorkload('busybox:1.36');
    const id = `t-${String(Date.now())}`;
    await provider.startTerminal(handle, id, { size: { rows: 24, columns: 80 } });
    const session = await provider.attachTerminal(handle, id);
    sessions.push(session);
    let output = '';
    session.onData((chunk) => {
      output += Buffer.from(chunk).toString('utf8');
    });
    session.write('tty\n');
    await expect.poll(() => output, { timeout: 10_000 }).toMatch(/\/dev\/pts\/\d+/);
    expect(output).not.toMatch(/not a tty/);
  });

  it('prompts with the working directory in the image people actually run', async () => {
    const handle = await runningWorkload('node:22-bookworm-slim');
    const id = `t-${String(Date.now())}`;
    await provider.startTerminal(handle, id, { size: { rows: 24, columns: 80 } });
    const session = await provider.attachTerminal(handle, id);
    sessions.push(session);
    let output = '';
    session.onData((chunk) => {
      output += Buffer.from(chunk).toString('utf8');
    });

    await expect.poll(() => output, { timeout: 10_000 }).toContain('/workspace $ ');
    session.write('cd /tmp\n');
    await expect.poll(() => output, { timeout: 10_000 }).toContain('/tmp $ ');
    expect(output).not.toContain('PS1');
  });

  it('the fallback shell prompts with the working directory too', async () => {
    const handle = await runningWorkload('node:22-bookworm-slim');
    const shell = await terminal(handle);

    await shell.run('cd /tmp', /\/tmp \$ /);
  });

  it('runs a command and returns its output', async () => {
    const handle = await runningWorkload();
    const shell = await terminal(handle);

    await shell.run('echo hello-from-the-container', /hello-from-the-container/);
  });

  it.skipIf(process.env.TEST_OCI_RUNTIME === 'runsc')(
    'is a real pseudo-terminal, not a pipe',
    async () => {
      const handle = await runningWorkload();
      const shell = await terminal(handle);

      const answer = await shell.run('tty', /(\/dev\/pts\/\d+|not a tty)/);
      expect(answer).toMatch(/\/dev\/pts\/\d+/);
      expect(answer).not.toMatch(/not a tty/);
    },
  );

  it('opens at the size it was given', async () => {
    const handle = await runningWorkload();
    const shell = await terminal(handle, 100, 30);

    await shell.run('stty size', /30 100/);
  });

  it('follows the window when it is resized', async () => {
    const handle = await runningWorkload();
    const shell = await terminal(handle, 80, 24);
    await shell.run('stty size', /24 80/);

    await shell.session.resize({ columns: 120, rows: 40 });

    await shell.run('stty size', /40 120/);
  });

  it('starts in the project workspace', async () => {
    const handle = await runningWorkload();
    await provider.seedWorkspace(handle, [
      { path: 'marker.txt', content: new TextEncoder().encode('here') },
    ]);
    const shell = await terminal(handle);

    await shell.run('pwd', /\/workspace/);
    await shell.run('cat marker.txt', /here/);
  });

  it('sees the file a command creates, in the same session', async () => {
    const handle = await runningWorkload();
    const shell = await terminal(handle);

    await shell.run('echo written > made.txt', /\$|#/);
    await shell.run('cat made.txt', /written/);
  });

  it('reports the shell ending', async () => {
    const handle = await runningWorkload();
    const shell = await terminal(handle);

    const exit = new Promise<number | null>((resolve) => shell.session.onExit(resolve));
    shell.session.write('exit\n');

    expect(await exit).toBe(0);
  });

  it('ends the shell when the session is closed', async () => {
    const handle = await runningWorkload();
    const shell = await terminal(handle);
    await shell.run('echo alive', /alive/);

    await shell.session.close();

    expect(() => shell.session.write('echo after\n')).not.toThrow();
  });

  it('carries characters that are not ASCII', async () => {
    const handle = await runningWorkload();
    const shell = await terminal(handle);

    await shell.run('echo "héllo wörld ✓"', /héllo wörld ✓/);
  });

  it('refuses to open a terminal in a container that is not there', async () => {
    await expect(
      provider.openTerminal(
        { externalId: 'no-such-container' },
        { size: { columns: 80, rows: 24 } },
      ),
    ).rejects.toThrow();
  });
});
