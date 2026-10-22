import type { DependencyProbe } from '../modules/health/health.service.js';
import type { ExecutionHostConfig } from './hosts.js';
import type { ExecutionProvider } from './provider.js';
import { describeLoad, type PlacementSource } from './scheduler.js';

export function executionProbe(provider: ExecutionProvider): DependencyProbe {
  return {
    name: `execution:${provider.name}`,
    check: async () => {
      const reason = await provider.unavailableReason();
      return reason === null
        ? { status: 'up' as const, detail: 'daemon reachable' }
        : { status: 'down' as const, detail: reason };
    },
  };
}

export function executionHostProbe(
  host: ExecutionHostConfig,
  provider: ExecutionProvider,
  placement: PlacementSource,
): DependencyProbe {
  return {
    name: `execution:${host.name}`,
    check: async () => {
      const reason = await provider.unavailableReason();

      if (reason !== null) return { status: 'down' as const, detail: reason };

      const loads = await placement.currentLoad();
      const load = loads.get(host.name) ?? { workloads: 0, cpuMillicores: 0, memoryMb: 0 };

      return {
        status: 'up' as const,
        detail: host.schedulable
          ? describeLoad(host, load)
          : `${describeLoad(host, load)}; not accepting new work`,
      };
    },
  };
}
