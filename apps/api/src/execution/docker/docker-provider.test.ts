import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { DockerExecutionProvider } from './docker-provider.js';
import type Docker from 'dockerode';

const silent = () => pino({ level: 'silent' });

const options = {
  workspacePath: '/workspace',
  networkPrefix: 'platform-runtimes',
  terminalReplayBytes: 64 * 1024,
  hardening: {
    maxOpenFiles: 8_192,
    maxProcesses: 128,
    workloadUser: '1000:1000',
    homePath: '/home/workload',
    tmpMegabytes: 256,
  },
  pullTimeoutMs: 1_000,
  availabilityTtlMs: 5_000,
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
};

function fakeDocker(ping: () => Promise<unknown>): Docker {
  return { ping } as unknown as Docker;
}

describe('reachability', () => {
  it('reports no reason when the daemon answers', async () => {
    const provider = new DockerExecutionProvider(
      fakeDocker(() => Promise.resolve('OK')),
      options,
      silent(),
    );

    expect(await provider.unavailableReason()).toBeNull();
  });

  it('names the problem when the daemon does not answer', async () => {
    const provider = new DockerExecutionProvider(
      fakeDocker(() => Promise.reject(new Error('connect ENOENT //./pipe/docker_engine'))),
      options,
      silent(),
    );

    const reason = await provider.unavailableReason();
    expect(reason).toContain('not reachable');
  });

  it('keeps the socket path out of the reason', async () => {
    const provider = new DockerExecutionProvider(
      fakeDocker(() => Promise.reject(new Error('connect ENOENT /var/run/docker.sock'))),
      options,
      silent(),
    );

    expect(await provider.unavailableReason()).not.toContain('docker.sock');
  });

  it('does not ping once per question', async () => {
    const ping = vi.fn(() => Promise.resolve('OK'));
    const provider = new DockerExecutionProvider(fakeDocker(ping), options, silent());

    await provider.unavailableReason();
    await provider.unavailableReason();
    await provider.unavailableReason();

    expect(ping).toHaveBeenCalledTimes(1);
  });

  it('asks again once the answer is stale', async () => {
    const ping = vi.fn(() => Promise.resolve('OK'));
    const provider = new DockerExecutionProvider(
      fakeDocker(ping),
      { ...options, availabilityTtlMs: 0 },
      silent(),
    );

    await provider.unavailableReason();
    await provider.unavailableReason();

    expect(ping).toHaveBeenCalledTimes(2);
  });

  it('notices when a daemon that was up goes down', async () => {
    let up = true;
    const provider = new DockerExecutionProvider(
      fakeDocker(() => (up ? Promise.resolve('OK') : Promise.reject(new Error('gone')))),
      { ...options, availabilityTtlMs: 0 },
      silent(),
    );

    expect(await provider.unavailableReason()).toBeNull();
    up = false;
    expect(await provider.unavailableReason()).toContain('not reachable');
  });
});
