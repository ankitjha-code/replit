import { randomUUID } from 'node:crypto';
import { pino } from 'pino';
import { afterAll, describe, expect, it } from 'vitest';
import {
  createDockerClient,
  DockerExecutionProvider,
} from '../src/execution/docker/docker-provider.js';
import type {
  ExecutionHandle,
  ProvisionRequest,
  TerminalSession,
} from '../src/execution/provider.js';

const docker = createDockerClient(process.env.DOCKER_SOCKET_PATH);
const reachable = await docker
  .ping()
  .then(() => true)
  .catch(() => false);

const dockerDesktop = reachable
  ? /docker desktop/i.test(
      ((await docker.info().catch(() => undefined)) as { OperatingSystem?: string } | undefined)
        ?.OperatingSystem ?? '',
    )
  : false;

const IMAGE = 'alpine:3.20';
const PREFIX = `platform-isolation-${process.pid}`;

function provider(
  publishMode: 'never' | 'always' = 'never',
  ociRuntime: string | null = process.env.TEST_OCI_RUNTIME ?? null,
  sharedServiceContainer?: string,
): DockerExecutionProvider {
  return new DockerExecutionProvider(
    docker,
    {
      workspacePath: '/workspace',
      networkPrefix: PREFIX,
      publishMode,
      ...(sharedServiceContainer ? { sharedServiceContainer } : {}),
      subnetPool: { base: '10.211.0.0/16', prefixLength: 28 },
      terminalReplayBytes: 64 * 1024,
      hardening: {
        ociRuntime,
        maxOpenFiles: 4_096,
        maxProcesses: 128,
        workloadUser: '1000:1000',
        homePath: '/home/workload',
        tmpMegabytes: 64,
      },
      pullTimeoutMs: 300_000,
      availabilityTtlMs: 0,
      read: { maxFileBytes: 1e6, maxTotalBytes: 1e7, maxFiles: 1_000, applyExclusions: true },
      collect: { maxFileBytes: 1e6, maxTotalBytes: 1e7, maxFiles: 1_000, applyExclusions: false },
    },
    pino({ level: 'silent' }),
  );
}

const created: ExecutionHandle[] = [];
const main = provider('never');
const publishing = provider('always');

async function workload(
  projectId: string,
  through: DockerExecutionProvider = main,
  image = IMAGE,
): Promise<ExecutionHandle> {
  const request: ProvisionRequest = {
    kind: 'runtime',
    workloadId: `iso-${randomUUID()}`,
    projectId,
    image,
    limits: { cpuMillicores: 500, memoryMb: 128, pidsLimit: 64 },
    env: {},
  };
  const handle = await through.create(request);
  created.push(handle);
  await through.start(handle);
  return handle;
}

async function exec(handle: ExecutionHandle, script: string): Promise<string> {
  const instance = await docker.getContainer(handle.externalId).exec({
    Cmd: ['/bin/sh', '-c', script],
    AttachStdout: true,
    AttachStderr: true,
  });
  const stream = await instance.start({ hijack: true, stdin: false });
  return new Promise<string>((resolve) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

async function addressOf(handle: ExecutionHandle): Promise<string> {
  const info = await docker.getContainer(handle.externalId).inspect();
  const [network] = Object.values(info.NetworkSettings.Networks);
  return network?.IPAddress ?? '';
}

function readUntil(session: TerminalSession, pattern: RegExp, timeoutMs = 10_000): Promise<string> {
  return new Promise((resolve) => {
    let text = '';
    const timer = setTimeout(() => resolve(text), timeoutMs);
    session.onData((chunk) => {
      text += Buffer.from(chunk).toString('utf8');
      if (pattern.test(text)) {
        clearTimeout(timer);
        resolve(text);
      }
    });
  });
}

describe.skipIf(!reachable)('isolation and durability against a real daemon', () => {
  afterAll(async () => {
    for (const handle of created) await main.destroy(handle).catch(() => undefined);
    for (const network of await main.listNetworks()) {
      if (network.name.startsWith(PREFIX))
        await main.removeNetwork(network.id).catch(() => undefined);
    }
  });

  it('one project cannot connect to another, though the same project can', async () => {
    const projectA = randomUUID();
    const projectB = randomUUID();

    const target = await workload(projectA);
    const sameProject = await workload(projectA);
    const otherProject = await workload(projectB);

    await exec(target, 'setsid nc -lk -p 8080 -e echo hello </dev/null >/dev/null 2>&1 &');
    await new Promise((resolve) => setTimeout(resolve, 1_000));

    const address = await addressOf(target);
    const probe = `nc -z -w 3 ${address} 8080 && echo PORT-OPEN || echo PORT-CLOSED`;

    const fromSameProject = await exec(sameProject, probe);
    const fromOtherProject = await exec(otherProject, probe);

    expect(fromSameProject, fromSameProject).toContain('PORT-OPEN');
    expect(fromOtherProject, fromOtherProject).toContain('PORT-CLOSED');
    expect(fromOtherProject).not.toContain('PORT-OPEN');
  }, 120_000);

  it.skipIf(process.env.TEST_OCI_RUNTIME === 'runsc')(
    'pins what publishing a port does to isolation, on this kind of daemon',
    async () => {
      const target = await workload(randomUUID(), publishing);
      const otherProject = await workload(randomUUID(), publishing);

      await exec(target, 'setsid nc -lk -p 8080 -e echo hello </dev/null >/dev/null 2>&1 &');
      await new Promise((resolve) => setTimeout(resolve, 1_000));

      const address = await addressOf(target);
      const output = await exec(
        otherProject,
        `nc -z -w 3 ${address} 8080 && echo PORT-OPEN || echo PORT-CLOSED`,
      );

      expect(output).toContain(dockerDesktop ? 'PORT-OPEN' : 'PORT-CLOSED');
    },
    120_000,
  );

  it('refuses a durable shell cleanly where the image lacks `script`', async () => {
    const handle = await workload(randomUUID());
    await expect(
      main.startTerminal(handle, randomUUID(), { size: { rows: 24, columns: 80 } }),
    ).rejects.toThrow('could not be started');
  }, 120_000);

  it('gives each project a small subnet of its own, and removes it when the last workload goes', async () => {
    const projectId = randomUUID();
    const handle = await workload(projectId);

    const network = `${PREFIX}-${projectId}`;
    const detail = await docker.getNetwork(network).inspect();
    const subnet = (detail.IPAM?.Config ?? [])[0]?.Subnet ?? '';

    expect(subnet).toMatch(/^10\.211\.\d+\.\d+\/28$/);

    await main.destroy(handle);
    created.splice(created.indexOf(handle), 1);

    await expect(docker.getNetwork(network).inspect()).rejects.toBeDefined();
  }, 120_000);

  it('runs sixty projects at once, well past where Docker’s own pool gave out', async () => {
    const handles: ExecutionHandle[] = [];
    const projects = new Set<string>();
    for (let index = 0; index < 60; index += 1) {
      const projectId = randomUUID();
      projects.add(projectId);
      handles.push(
        await main.create({
          kind: 'runtime',
          workloadId: `scale-${randomUUID()}`,
          projectId,
          image: IMAGE,
          limits: { cpuMillicores: 100, memoryMb: 32, pidsLimit: 16 },
          env: {},
        }),
      );
    }

    expect(handles).toHaveLength(60);

    for (const handle of handles) await main.destroy(handle);
    const remaining = (await main.listNetworks()).filter(
      (network) => network.name.startsWith(PREFIX) && projects.has(network.projectId ?? ''),
    );
    expect(remaining).toEqual([]);
  }, 600_000);

  it('says it is unavailable, rather than failing every start, when the sandbox runtime is missing', async () => {
    const missing = provider('never', 'not-an-installed-runtime');
    expect(await missing.unavailableReason()).toMatch(
      /"not-an-installed-runtime" is not installed/,
    );
  });

  it('leaves no network behind when the shared database server was attached to it', async () => {
    const shared = await docker
      .getContainer('platform-userdb')
      .inspect()
      .then(() => 'platform-userdb')
      .catch(() => null);
    if (!shared) return;
    const withShared = provider('never', null, shared);
    const projectId = randomUUID();
    const handle = await workload(projectId, withShared);
    const before = (await withShared.listNetworks()).filter((n) => n.projectId === projectId);
    expect(before).toHaveLength(1);

    await withShared.stop(handle, 1);
    await withShared.destroy(handle);
    for (const network of await withShared.listNetworks()) {
      if (network.projectId === projectId) await withShared.removeNetwork(network.id);
    }

    const after = (await withShared.listNetworks()).filter((n) => n.projectId === projectId);
    expect(after).toEqual([]);
  });

  it('measures what a workload writes, for the disk limit', async () => {
    const handle = await workload(randomUUID());
    const before = (await main.diskUsage(handle)) ?? 0;

    await exec(handle, 'dd if=/dev/zero of=/workspace/big bs=1M count=40 2>/dev/null; sync');
    const after = await main.diskUsage(handle);

    expect(after).not.toBeNull();
    expect(after! - before).toBeGreaterThanOrEqual(40 * 1024 * 1024);
    await exec(handle, 'dd if=/dev/zero of=/tmp/scratch bs=1M count=20 2>/dev/null');
    expect((await main.diskUsage(handle))! - after!).toBeLessThan(1024 * 1024);
  });

  it('a shell survives the process that started it, and keeps its screen', async () => {
    const handle = await workload(randomUUID(), main, 'busybox:1.36');
    const terminalId = randomUUID();

    await main.startTerminal(handle, terminalId, { size: { rows: 24, columns: 80 } });

    const first = await main.attachTerminal(handle, terminalId);
    const firstOutput = readUntil(first, /marker-42/);
    first.write('echo marker-$((40+2))\n');
    expect(await firstOutput).toContain('marker-42');
    await first.close();

    const afterRestart = provider();
    expect(await afterRestart.terminalRunning(handle, terminalId)).toBe(true);

    const second = await afterRestart.attachTerminal(handle, terminalId);
    const secondOutput = readUntil(second, /marker-42[\s\S]*second-7/);
    second.write('echo second-$((3+4))\n');
    const text = await secondOutput;

    expect(text).toContain('marker-42');
    expect(text).toContain('second-7');

    await second.resize({ rows: 41, columns: 101 });
    const sized = readUntil(second, /41 101/);
    second.write('stty size\n');
    expect(await sized).toContain('41 101');
    await second.close();

    await afterRestart.stopTerminal(handle, terminalId);
    expect(await afterRestart.terminalRunning(handle, terminalId)).toBe(false);
  }, 120_000);
});
