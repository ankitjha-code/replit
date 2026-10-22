import { describe, expect, it } from 'vitest';
import {
  LABEL_MANAGED,
  LABEL_PROJECT,
  LABEL_RUNTIME,
  containerCreateOptions,
  containerName,
  providerState,
} from './container-spec.js';
import type { ProvisionRequest } from '../provider.js';

const request: ProvisionRequest = {
  workloadId: '018f0000-0000-7000-8000-0000000000bb',
  kind: 'runtime',
  projectId: '018f0000-0000-7000-8000-0000000000aa',
  image: 'node:22-bookworm-slim',
  limits: { cpuMillicores: 1_500, memoryMb: 512, pidsLimit: 128 },
  env: { PORT: '3000' },
};

const options = {
  workspacePath: '/workspace',
  network: 'platform-runtimes-018f0000-0000-7000-8000-0000000000aa',
  publishPorts: false,
  hardening: {
    maxOpenFiles: 8_192,
    maxProcesses: 128,
    workloadUser: '1000:1000',
    homePath: '/home/workload',
    tmpMegabytes: 256,
  },
};

const spec = (overrides: Partial<ProvisionRequest> = {}) =>
  containerCreateOptions({ ...request, ...overrides }, options);

describe('isolation', () => {
  it('mounts nothing into the workload', () => {
    const host = spec().HostConfig!;
    expect(host.Binds).toEqual([]);
    expect(host.Mounts).toEqual([]);
  });

  it('never asks for privilege', () => {
    expect(spec().HostConfig?.Privileged).toBe(false);
  });

  it('drops every capability', () => {
    expect(spec().HostConfig?.CapDrop).toEqual(['ALL']);
  });

  it('refuses privilege escalation', () => {
    expect(spec().HostConfig?.SecurityOpt).toContain('no-new-privileges');
  });

  it('puts a workload on its own project network, not the platform one', () => {
    expect(spec().HostConfig?.NetworkMode).toBe(options.network);
    expect(spec().HostConfig?.NetworkMode).not.toBe('platform');
  });

  it('passes only the environment it was given, plus a home directory', () => {
    expect(spec().Env).toEqual(['PORT=3000', 'HOME=/home/workload']);
  });

  it('passes nothing of the project’s when there is nothing to pass', () => {
    expect(spec({ env: {} }).Env).toEqual(['HOME=/home/workload']);
  });

  it('does not let a project override HOME', () => {
    const env = spec({ env: { HOME: '/root' } }).Env ?? [];
    expect(env.at(-1)).toBe('HOME=/home/workload');
  });
});

describe('publishing preview ports', () => {
  it('publishes nothing unless told to, because a published port crosses project networks', () => {
    expect(spec().HostConfig?.PortBindings).toEqual({});
  });

  it('publishes to loopback only, when it must', () => {
    const published = containerCreateOptions(request, { ...options, publishPorts: true });
    const bindings = Object.values(published.HostConfig?.PortBindings ?? {}).flat() as {
      HostIp: string;
    }[];

    expect(bindings.length).toBeGreaterThan(0);
    expect(bindings.every((binding) => binding.HostIp === '127.0.0.1')).toBe(true);
  });
});

describe('running unprivileged', () => {
  it('runs as the configured numeric user, never root', () => {
    expect(spec().User).toBe('1000:1000');
  });

  it('leaves the user unset only when the installation opts out', () => {
    const asRoot = containerCreateOptions(request, {
      ...options,
      hardening: { ...options.hardening, workloadUser: null },
    });
    expect(asRoot.User).toBeUndefined();
  });

  it('makes /tmp writable by that user, explicitly', () => {
    expect(spec().HostConfig?.Tmpfs?.['/tmp']).toContain('mode=1777');
  });
});

describe('limits', () => {
  it('translates a CPU share into what Docker measures', () => {
    expect(spec().HostConfig?.NanoCpus).toBe(1_500_000_000);
  });

  it('translates a memory ceiling into bytes', () => {
    expect(spec().HostConfig?.Memory).toBe(512 * 1024 * 1024);
  });

  it('pins swap to the memory ceiling', () => {
    const host = spec().HostConfig!;
    expect(host.MemorySwap).toBe(host.Memory);
  });

  it('applies a process limit', () => {
    expect(spec().HostConfig?.PidsLimit).toBe(128);
  });

  it('leaves the out-of-memory killer in place', () => {
    expect(spec().HostConfig?.OomKillDisable).toBe(false);
  });
});

describe('lifecycle', () => {
  it('does not restart on its own', () => {
    expect(spec().HostConfig?.RestartPolicy).toEqual({ Name: 'no' });
  });

  it('is not removed automatically', () => {
    expect(spec().HostConfig?.AutoRemove).toBe(false);
  });

  it('stays alive rather than running the project', () => {
    expect(spec().Entrypoint).toEqual(['/bin/sh', '-c']);
    expect(String(spec().Cmd)).toContain('sleep');
  });

  it('keeps a terminal attachable without recreating the container', () => {
    expect(spec().Tty).toBe(true);
    expect(spec().OpenStdin).toBe(true);
  });

  it('starts in the workspace', () => {
    expect(spec().WorkingDir).toBe('/workspace');
  });
});

describe('naming and labelling', () => {
  it('names a container after the runtime, not the project', () => {
    expect(containerName('runtime', request.workloadId)).toBe(
      `platform-runtime-${request.workloadId}`,
    );
    expect(spec().name).toBe(`platform-runtime-${request.workloadId}`);
  });

  it('labels what it owns, so cleanup can find only its own', () => {
    const labels = spec().Labels!;
    expect(labels[LABEL_MANAGED]).toBe('true');
    expect(labels[LABEL_RUNTIME]).toBe(request.workloadId);
    expect(labels[LABEL_PROJECT]).toBe(request.projectId);
  });
});

describe('reading Docker state back', () => {
  it('reports a running container as running', () => {
    expect(providerState({ State: { Running: true, Status: 'running' } })).toBe('running');
  });

  it('reports an exited container as exited', () => {
    expect(providerState({ State: { Running: false, Status: 'exited' } })).toBe('exited');
    expect(providerState({ State: { Running: false, Status: 'dead' } })).toBe('exited');
  });

  it('treats paused and restarting as neither usable nor gone', () => {
    expect(providerState({ State: { Running: false, Status: 'paused' } })).toBe('created');
    expect(providerState({ State: { Running: false, Status: 'restarting' } })).toBe('created');
  });

  it('reports a container with no state at all as absent', () => {
    expect(providerState({})).toBe('absent');
  });
});

describe('opt-in hardening', () => {
  it('sets neither a storage limit nor a runtime unless asked', () => {
    const host = spec().HostConfig as Record<string, unknown>;
    expect(host.StorageOpt).toBeUndefined();
    expect(host.Runtime).toBeUndefined();
  });

  it('asks the container runtime for a hard storage limit when enforcing', () => {
    const host = containerCreateOptions(request, {
      ...options,
      hardening: { ...options.hardening, storageLimitMb: 2048 },
    }).HostConfig as Record<string, unknown>;
    expect(host.StorageOpt).toEqual({ size: '2048M' });
  });

  it('runs the workload under gVisor when configured', () => {
    const host = containerCreateOptions(request, {
      ...options,
      hardening: { ...options.hardening, ociRuntime: 'runsc' },
    }).HostConfig as Record<string, unknown>;
    expect(host.Runtime).toBe('runsc');
  });
});
