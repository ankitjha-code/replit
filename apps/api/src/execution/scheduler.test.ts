import pino from 'pino';
import { describe, expect, it } from 'vitest';
import type { ExecutionHostConfig } from './hosts.js';
import type { ExecutionProvider } from './provider.js';
import { RoutingExecutionProvider } from './routing-provider.js';
import { choosePlacement, type HostLoad } from './scheduler.js';

const host = (name: string, overrides: Partial<ExecutionHostConfig> = {}): ExecutionHostConfig => ({
  name,
  cpuMillicores: 4_000,
  memoryMb: 4_096,
  maxWorkloads: 10,
  schedulable: true,
  ...overrides,
});
const small = { cpuMillicores: 500, memoryMb: 512, pidsLimit: 64 };

describe('choosing a host', () => {
  it('spreads work to the host with the most room on its tightest dimension', () => {
    const loads = new Map<string, HostLoad>([
      ['a', { workloads: 1, cpuMillicores: 3_000, memoryMb: 512 }],
      ['b', { workloads: 1, cpuMillicores: 500, memoryMb: 512 }],
    ]);
    expect(choosePlacement([host('a'), host('b')], loads, small).host.name).toBe('b');
  });

  it('never places on a host that is not accepting work', () => {
    const placed = choosePlacement(
      [host('a', { schedulable: false }), host('b')],
      new Map([['b', { workloads: 9, cpuMillicores: 3_000, memoryMb: 3_000 }]]),
      small,
    );
    expect(placed.host.name).toBe('b');
  });

  it('refuses rather than overcommitting', () => {
    const full = new Map([['a', { workloads: 10, cpuMillicores: 0, memoryMb: 0 }]]);
    expect(() => choosePlacement([host('a')], full, small)).toThrow(/full/);
    expect(() => choosePlacement([host('a', { schedulable: false })], new Map(), small)).toThrow(
      /accepting/,
    );
  });
});

describe('drained hosts', () => {
  function routing(drained: string[]) {
    const created: string[] = [];
    const provider = (name: string) =>
      ({
        create: async () => {
          created.push(name);
          return { externalId: `c-${name}` };
        },
      }) as unknown as ExecutionProvider;

    const router = new RoutingExecutionProvider(
      {
        hosts: [host('a'), host('b')],
        providers: new Map([
          ['a', provider('a')],
          ['b', provider('b')],
        ]),
        placement: {
          // "a" is emptier, so it would be chosen if it were not drained.
          currentLoad: async () =>
            new Map([['b', { workloads: 5, cpuMillicores: 2_000, memoryMb: 2_000 }]]),
          drainedHosts: async () => new Set(drained),
        },
        defaultHost: 'a',
      },
      pino({ level: 'silent' }),
    );
    return { router, created };
  }

  const request = { workloadId: 'w', limits: small } as never;

  it('places nothing new on a drained host', async () => {
    const { router, created } = routing(['a']);
    const handle = await router.create(request);
    expect(created).toEqual(['b']);
    expect(handle.host).toBe('b');
  });

  it('places normally once the drain is lifted', async () => {
    const { router, created } = routing([]);
    await router.create(request);
    expect(created).toEqual(['a']);
  });

  it('refuses when every host is drained, rather than ignoring the drain', async () => {
    const { router } = routing(['a', 'b']);
    await expect(router.create(request)).rejects.toThrow(/accepting/);
  });
});
