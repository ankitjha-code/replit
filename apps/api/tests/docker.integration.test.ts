import { pino } from 'pino';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { AppError } from '../src/errors/app-error.js';
import {
  containerName,
  LABEL_MANAGED,
  LABEL_PROJECT,
  LABEL_RUNTIME,
} from '../src/execution/docker/container-spec.js';
import {
  createDockerClient,
  DockerExecutionProvider,
} from '../src/execution/docker/docker-provider.js';
import type { ExecutionHandle, ProvisionRequest } from '../src/execution/provider.js';

/**
 * The Docker provider against a real daemon.
 *
 * Containers are actually created, seeded, started, stopped and removed. The
 * assertions read the daemon's own view rather than the provider's, because
 * the question being asked is whether the limits and the isolation settings
 * genuinely reached the container.
 *
 * Skips with a message when Docker is not running, rather than passing against
 * nothing.
 */

const docker = createDockerClient(process.env.DOCKER_SOCKET_PATH);

const reachable = await docker
  .ping()
  .then(() => true)
  .catch(() => false);

/** Small on purpose: this suite is about the provider, not about an image. */
const IMAGE = 'alpine:3.20';
const NETWORK = 'platform-runtimes-test';

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
const created: ExecutionHandle[] = [];

function request(overrides: Partial<ProvisionRequest> = {}): ProvisionRequest {
  counter += 1;
  return {
    // Not a real UUID, and it does not need to be: what matters is that two
    // tests never contend for one container name.
    kind: 'runtime' as const,
    workloadId: `test-${process.pid}-${counter}`,
    projectId: '018f0000-0000-7000-8000-0000000000aa',
    image: IMAGE,
    limits: { cpuMillicores: 500, memoryMb: 256, pidsLimit: 64 },
    env: {},
    ...overrides,
  };
}

/** Creates a workload and remembers it, so the suite leaves nothing behind. */
async function createWorkload(overrides: Partial<ProvisionRequest> = {}) {
  const spec = request(overrides);
  const handle = await provider.create(spec);
  created.push(handle);
  return { handle, spec };
}

/** Runs a command inside a container and returns what it printed. */
async function exec(handle: ExecutionHandle, command: string[]): Promise<string> {
  const instance = await docker.getContainer(handle.externalId).exec({
    Cmd: command,
    AttachStdout: true,
    AttachStderr: true,
  });
  const stream = await instance.start({ hijack: true, stdin: false });

  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    stream.on('error', reject);
  });
}

describe.skipIf(!reachable)('the Docker provider against a real daemon', () => {
  afterEach(async () => {
    while (created.length > 0) {
      const handle = created.pop()!;
      await provider.destroy(handle).catch(() => undefined);
    }
  });

  afterAll(async () => {
    // The networks this suite made — one per project since task 53, so the old
    // single name no longer matched anything and every run leaked one.
    for (const network of await provider.listNetworks()) {
      if (network.name.startsWith(NETWORK)) {
        await provider.removeNetwork(network.id).catch(() => undefined);
      }
    }
  });

  it('reports itself available', async () => {
    expect(await provider.unavailableReason()).toBeNull();
  });

  describe('creating a workload', () => {
    it('creates a real container', async () => {
      const { handle, spec } = await createWorkload();

      const inspected = await docker.getContainer(handle.externalId).inspect();
      expect(inspected.Name).toBe(`/${containerName('runtime', spec.workloadId)}`);
    });

    it('pulls an image that is not on the host', async () => {
      // Alpine may or may not be present before this runs. Either way the
      // container is created, which is only possible if the image is there.
      const { handle } = await createWorkload();
      expect(handle.externalId).toMatch(/^[0-9a-f]{12,}$/);
    });

    it('labels the container as the platform own', async () => {
      const { handle, spec } = await createWorkload();

      const { Config } = await docker.getContainer(handle.externalId).inspect();
      expect(Config.Labels[LABEL_MANAGED]).toBe('true');
      expect(Config.Labels[LABEL_RUNTIME]).toBe(spec.workloadId);
      expect(Config.Labels[LABEL_PROJECT]).toBe(spec.projectId);
    });

    it('replaces a container left behind by a previous attempt', async () => {
      // A failed start can leave one holding the name. The next start must not
      // be blocked by it for ever.
      const spec = request();
      const first = await provider.create(spec);
      const second = await provider.create(spec);
      created.push(second);

      expect(second.externalId).not.toBe(first.externalId);
      expect(await provider.inspect(first)).toBe('absent');
    });
  });

  describe('isolation, as the daemon sees it', () => {
    it('has nothing mounted into it', async () => {
      // The assertion that matters most in this file. A workload with the
      // daemon socket mounted can create a privileged container and own the
      // host.
      const { handle } = await createWorkload();

      const inspected = await docker.getContainer(handle.externalId).inspect();
      expect(inspected.Mounts).toEqual([]);
      expect(inspected.HostConfig.Binds ?? []).toEqual([]);
    });

    it('holds no capabilities', async () => {
      const { handle } = await createWorkload();
      const { HostConfig } = await docker.getContainer(handle.externalId).inspect();

      expect(HostConfig.CapDrop).toEqual(['ALL']);
      expect(HostConfig.Privileged).toBe(false);
      expect(HostConfig.SecurityOpt).toContain('no-new-privileges');
    });

    it('sits on its own project network and nothing else', async () => {
      const { handle, spec } = await createWorkload();
      const { NetworkSettings } = await docker.getContainer(handle.externalId).inspect();

      // One network, named for this project. Not the platform's, and not a
      // shared one every project is on — which is the route task 53 removed.
      expect(Object.keys(NetworkSettings.Networks)).toEqual([`${NETWORK}-${spec.projectId}`]);
    });

    it('runs as the unprivileged user, and can still write its workspace and home', async () => {
      const { handle } = await createWorkload();
      await provider.start(handle);

      // No User on the exec: it inherits the container's, which is the point.
      const exec = await docker.getContainer(handle.externalId).exec({
        Cmd: [
          '/bin/sh',
          '-c',
          'id -u && touch /workspace/new-file && echo cache > "$HOME/cache" && echo wrote',
        ],
        AttachStdout: true,
        AttachStderr: true,
      });
      const stream = await exec.start({ hijack: true, stdin: false });
      let output = '';
      stream.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
      await new Promise((resolve) => stream.on('end', resolve));

      expect(output).toContain('1000');
      expect(output).toContain('wrote');
    });

    it('carries no environment the platform did not give it', async () => {
      const { handle } = await createWorkload();
      const { Config } = await docker.getContainer(handle.externalId).inspect();

      // The image contributes its own PATH, which is not the platform's doing.
      // Nothing resembling platform configuration is present.
      const joined = (Config.Env ?? []).join('\n');
      expect(joined).not.toMatch(/DATABASE_URL|SESSION|SECRET|POSTGRES/i);
    });
  });

  describe('limits, as the daemon sees them', () => {
    it('applies the CPU share', async () => {
      const { handle } = await createWorkload();
      const { HostConfig } = await docker.getContainer(handle.externalId).inspect();

      expect(HostConfig.NanoCpus).toBe(500_000_000);
    });

    it('applies the memory ceiling, and pins swap to it', async () => {
      const { handle } = await createWorkload();
      const { HostConfig } = await docker.getContainer(handle.externalId).inspect();

      expect(HostConfig.Memory).toBe(256 * 1024 * 1024);
      expect(HostConfig.MemorySwap).toBe(HostConfig.Memory);
    });

    it('applies the process limit', async () => {
      const { handle } = await createWorkload();
      const { HostConfig } = await docker.getContainer(handle.externalId).inspect();

      expect(HostConfig.PidsLimit).toBe(64);
    });

    it('reports the memory ceiling inside the container', async () => {
      // Read from the container's own cgroup, which is the limit actually
      // being enforced rather than the one that was requested.
      const { handle } = await createWorkload();
      await provider.start(handle);

      const output = await exec(handle, [
        '/bin/sh',
        '-c',
        'cat /sys/fs/cgroup/memory.max 2>/dev/null || cat /sys/fs/cgroup/memory/memory.limit_in_bytes',
      ]);

      expect(output).toContain(String(256 * 1024 * 1024));
    });
  });

  describe('the workspace', () => {
    it('puts the project files inside the container', async () => {
      const { handle } = await createWorkload();
      await provider.seedWorkspace(handle, [
        { path: 'index.js', content: new TextEncoder().encode('console.log("hi")') },
      ]);
      await provider.start(handle);

      const output = await exec(handle, ['/bin/sh', '-c', 'cat /workspace/index.js']);
      expect(output).toContain('console.log("hi")');
    });

    it('keeps a nested path nested', async () => {
      const { handle } = await createWorkload();
      await provider.seedWorkspace(handle, [
        { path: 'src', content: null },
        { path: 'src/app.js', content: new TextEncoder().encode('nested') },
      ]);
      await provider.start(handle);

      const output = await exec(handle, ['/bin/sh', '-c', 'cat /workspace/src/app.js']);
      expect(output).toContain('nested');
    });

    it('writes nothing when a path would escape the workspace', async () => {
      // The archive is refused as a whole, so nothing lands outside and
      // nothing lands inside either.
      const { handle } = await createWorkload();

      await expect(
        provider.seedWorkspace(handle, [
          { path: 'ok.js', content: new TextEncoder().encode('ok') },
          { path: '../../escape.js', content: new TextEncoder().encode('bad') },
        ]),
      ).rejects.toBeInstanceOf(AppError);

      await provider.start(handle);
      const output = await exec(handle, ['/bin/sh', '-c', 'ls /workspace 2>&1']);
      expect(output).not.toContain('ok.js');
    });

    it('does nothing at all for a project with no files', async () => {
      const { handle } = await createWorkload();
      await expect(provider.seedWorkspace(handle, [])).resolves.toBeUndefined();
    });
  });

  describe('reading the workspace back', () => {
    /** Runs a command in the container, the way a person would. */
    async function run(handle: ExecutionHandle, command: string): Promise<void> {
      const instance = await docker.getContainer(handle.externalId).exec({
        Cmd: ['/bin/sh', '-c', command],
        AttachStdout: true,
        AttachStderr: true,
      });
      const stream = await instance.start({ hijack: true, stdin: false });
      await new Promise((resolve) => stream.on('end', resolve));
    }

    it('brings back a file a command created', async () => {
      // The point of the whole feature: work done inside a container has to be
      // recoverable, or the container is where work goes to disappear.
      const { handle } = await createWorkload();
      await provider.start(handle);
      await run(handle, 'echo generated > /workspace/made.txt');

      const files = await provider.readWorkspace(handle);

      const made = files.find((file) => file.path === 'made.txt');
      expect(Buffer.from(made!.content).toString()).toContain('generated');
    });

    it('brings back what was seeded, unchanged', async () => {
      const { handle } = await createWorkload();
      await provider.seedWorkspace(handle, [
        { path: 'src/app.js', content: new TextEncoder().encode('const a = 1') },
      ]);
      await provider.start(handle);

      const files = await provider.readWorkspace(handle);

      const app = files.find((file) => file.path === 'src/app.js');
      expect(Buffer.from(app!.content).toString()).toBe('const a = 1');
    });

    it('leaves installed dependencies in the container', async () => {
      // A real node_modules is a hundred thousand files. Reading it back would
      // exceed every limit the project has while storing nothing anyone wrote.
      const { handle } = await createWorkload();
      await provider.start(handle);
      await run(
        handle,
        'mkdir -p /workspace/node_modules/pkg && echo x > /workspace/node_modules/pkg/i.js',
      );
      await run(handle, 'echo mine > /workspace/mine.txt');

      const files = await provider.readWorkspace(handle);

      expect(files.map((file) => file.path)).toContain('mine.txt');
      expect(files.some((file) => file.path.startsWith('node_modules/'))).toBe(false);
    });

    it('brings back nothing at all from an empty workspace', async () => {
      const { handle } = await createWorkload();
      await provider.start(handle);

      await expect(provider.readWorkspace(handle)).resolves.toEqual([]);
    });

    it('refuses rather than answering short when there is too much', async () => {
      // The caller deletes what it did not see. A partial answer presented as
      // a complete one would delete files that were simply never read.
      const small = new DockerExecutionProvider(
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
          read: { maxFileBytes: 1_000_000, maxTotalBytes: 10, maxFiles: 1, applyExclusions: true },
          collect: {
            maxFileBytes: 1_000_000,
            maxTotalBytes: 10,
            maxFiles: 1,
            applyExclusions: false,
          },
        },
        pino({ level: 'silent' }),
      );

      const { handle } = await createWorkload();
      await provider.start(handle);
      await run(handle, 'echo aaaaaaaaaaaaaaaaaaaa > /workspace/a.txt; echo b > /workspace/b.txt');

      await expect(small.readWorkspace(handle)).rejects.toThrow();
    });
  });

  describe('the lifecycle', () => {
    it('starts a container and reports it running', async () => {
      const { handle } = await createWorkload();
      await provider.start(handle);

      expect(await provider.inspect(handle)).toBe('running');
    });

    it('stays up rather than exiting immediately', async () => {
      // A development environment that exits the moment it starts is useless,
      // and several of these images exit by default.
      const { handle } = await createWorkload();
      await provider.start(handle);
      await new Promise((resolve) => setTimeout(resolve, 500));

      expect(await provider.inspect(handle)).toBe('running');
    });

    it('starting something already running succeeds', async () => {
      const { handle } = await createWorkload();
      await provider.start(handle);

      await expect(provider.start(handle)).resolves.toBeUndefined();
    });

    it('stops a running container', async () => {
      const { handle } = await createWorkload();
      await provider.start(handle);
      await provider.stop(handle, 1);

      expect(await provider.inspect(handle)).toBe('exited');
    });

    it('stopping something already stopped succeeds', async () => {
      const { handle } = await createWorkload();
      await provider.start(handle);
      await provider.stop(handle, 1);

      await expect(provider.stop(handle, 1)).resolves.toBeUndefined();
    });

    it('stopping something that is gone succeeds', async () => {
      // Reconciliation depends on it: the platform must be able to ask for a
      // state it may already be in.
      const { handle } = await createWorkload();
      await provider.destroy(handle);

      await expect(provider.stop(handle, 1)).resolves.toBeUndefined();
    });

    it('removes a container', async () => {
      const { handle } = await createWorkload();
      await provider.start(handle);
      await provider.destroy(handle);

      expect(await provider.inspect(handle)).toBe('absent');
    });

    it('removing something twice succeeds', async () => {
      const { handle } = await createWorkload();
      await provider.destroy(handle);

      await expect(provider.destroy(handle)).resolves.toBeUndefined();
    });

    it('reports a container the daemon never heard of as absent', async () => {
      expect(await provider.inspect({ externalId: 'no-such-container-anywhere' })).toBe('absent');
    });
  });
});
