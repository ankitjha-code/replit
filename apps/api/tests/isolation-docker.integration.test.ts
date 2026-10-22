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

/**
 * Two claims that only a real container runtime can settle.
 *
 * - **One project cannot reach another over the network.** The largest claim
 *   in the hardening work, and the hole it exists to close: a bridge network is
 *   a local network, and without one per project any project's code could
 *   connect to any other's.
 * - **A terminal outlives the process that started it.** A second provider,
 *   sharing nothing in memory with the first, stands in for the control plane
 *   restarting.
 */

const docker = createDockerClient(process.env.DOCKER_SOCKET_PATH);
const reachable = await docker
  .ping()
  .then(() => true)
  .catch(() => false);

/** Docker Desktop and a Linux engine route between networks differently. */
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
        // Set TEST_OCI_RUNTIME=runsc to run this suite under gVisor.
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

/** Collects what a terminal prints until a pattern appears, or gives up. */
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

    // A listener in project A, started detached so it outlives this exec.
    await exec(target, 'setsid nc -lk -p 8080 -e echo hello </dev/null >/dev/null 2>&1 &');
    await new Promise((resolve) => setTimeout(resolve, 1_000));

    const address = await addressOf(target);
    // Words that do not contain each other, so a check for one cannot be
    // satisfied by the other.
    const probe = `nc -z -w 3 ${address} 8080 && echo PORT-OPEN || echo PORT-CLOSED`;

    const fromSameProject = await exec(sameProject, probe);
    const fromOtherProject = await exec(otherProject, probe);

    // The control: without it, "closed" could just mean the listener never
    // started, and the test would pass for the wrong reason.
    expect(fromSameProject, fromSameProject).toContain('PORT-OPEN');
    expect(fromOtherProject, fromOtherProject).toContain('PORT-CLOSED');
    expect(fromOtherProject).not.toContain('PORT-OPEN');
  }, 120_000);

  // Docker's own networking; under gVisor the connection is refused, which is
  // stricter, so the finding this pins does not apply there.
  it.skipIf(process.env.TEST_OCI_RUNTIME === 'runsc')(
    'pins what publishing a port does to isolation, on this kind of daemon',
    async () => {
      /*
       * Why the platform does not publish preview ports except on Docker Desktop.
       *
       * This asserts the daemon's behaviour, not the platform's, and it is here
       * so the reason survives. On Docker Desktop, publishing looks harmless —
       * it is bound to the host's loopback — and it opens the port to every
       * other project's network. A Linux engine keeps networks apart whether or
       * not a port is published (found by the first CI run, on Linux), which is
       * why production, on Linux, never publishes and loses nothing by it.
       * If either answer changes, the daemon changed and the decision can be
       * revisited.
       */
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
    // Alpine's cut-down BusyBox has no `script`. The refusal is what makes the
    // session service fall back to an ordinary terminal, so it must be a clean
    // refusal rather than a shell that silently never started.
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

    // Small, and from the platform's range rather than Docker's default pool,
    // which runs out after about thirty networks.
    expect(subnet).toMatch(/^10\.211\.\d+\.\d+\/28$/);

    await main.destroy(handle);
    created.splice(created.indexOf(handle), 1);

    await expect(docker.getNetwork(network).inspect()).rejects.toBeDefined();
  }, 120_000);

  it('runs sixty projects at once, well past where Docker’s own pool gave out', async () => {
    // The defect: at about thirty project networks the daemon refused every new
    // one, and no project could start. Sixty, created and then removed.
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
    // Only this test's sixty: earlier tests in the file still hold networks of
    // their own until the file's cleanup runs.
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
    // What production always has: the project database server joined to every
    // project network. Deleting a project must still remove its network.
    const shared = await docker
      .getContainer('platform-userdb')
      .inspect()
      .then(() => 'platform-userdb')
      .catch(() => null);
    if (!shared) return; // needs `pnpm infra:up`
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

    // 40 MB into the workspace, as the unprivileged workload user.
    await exec(handle, 'dd if=/dev/zero of=/workspace/big bs=1M count=40 2>/dev/null; sync');
    const after = await main.diskUsage(handle);

    expect(after).not.toBeNull();
    expect(after! - before).toBeGreaterThanOrEqual(40 * 1024 * 1024);
    // A tmpfs write is memory, bounded separately, and not counted as disk.
    await exec(handle, 'dd if=/dev/zero of=/tmp/scratch bs=1M count=20 2>/dev/null');
    expect((await main.diskUsage(handle))! - after!).toBeLessThan(1024 * 1024);
  });

  it('a shell survives the process that started it, and keeps its screen', async () => {
    // A catalogue image. The full BusyBox build has `script`, as do the
    // Debian-based language images.
    const handle = await workload(randomUUID(), main, 'busybox:1.36');
    const terminalId = randomUUID();

    await main.startTerminal(handle, terminalId, { size: { rows: 24, columns: 80 } });

    const first = await main.attachTerminal(handle, terminalId);
    const firstOutput = readUntil(first, /marker-42/);
    first.write('echo marker-$((40+2))\n');
    expect(await firstOutput).toContain('marker-42');
    await first.close();

    // A provider sharing nothing with the first: the control plane restarted.
    const afterRestart = provider();
    expect(await afterRestart.terminalRunning(handle, terminalId)).toBe(true);

    const second = await afterRestart.attachTerminal(handle, terminalId);
    const secondOutput = readUntil(second, /marker-42[\s\S]*second-7/);
    second.write('echo second-$((3+4))\n');
    const text = await secondOutput;

    // The screen from before the restart, and a shell still taking commands.
    expect(text).toContain('marker-42');
    expect(text).toContain('second-7');

    // Resizing reaches the shell's own terminal, and puts nothing on screen.
    await second.resize({ rows: 41, columns: 101 });
    const sized = readUntil(second, /41 101/);
    second.write('stty size\n');
    expect(await sized).toContain('41 101');
    await second.close();

    await afterRestart.stopTerminal(handle, terminalId);
    expect(await afterRestart.terminalRunning(handle, terminalId)).toBe(false);
  }, 120_000);
});
