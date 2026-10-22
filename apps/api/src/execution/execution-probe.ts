import type { DependencyProbe } from '../modules/health/health.service.js';
import type { ExecutionHostConfig } from './hosts.js';
import type { ExecutionProvider } from './provider.js';
import { describeLoad, type PlacementSource } from './scheduler.js';

/**
 * Health probe for the execution backend.
 *
 * Registered only when a backend is configured. An installation deliberately
 * running without one is not unhealthy, and reporting it as down would make
 * readiness useless for the thing it is actually for.
 *
 * The provider's own reason is reported, because it is already written to be
 * shown and carries no internal detail.
 */
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

/**
 * Health probe for one execution host, with what is placed on it.
 *
 * One row per host rather than one for the plane, because "the execution plane
 * is up" is not a useful answer for an installation with three machines and one
 * down: the whole point of having three is that losing one is survivable, and an
 * operator needs to know which.
 *
 * The detail carries the host's load. It is the only place capacity is visible
 * at all, and it costs nothing: the numbers are already being read to decide
 * where the next workload goes.
 */
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
