import type { Database } from '../db/client.js';
import type { HostLoad, PlacementSource } from './scheduler.js';

/**
 * What the platform has placed on each execution host.
 *
 * Read from the platform's own records rather than from the machines. Asking a
 * host what it is running would count things the platform did not put there, and
 * would make placing a workload depend on every host answering — so one slow
 * machine would stop the whole installation starting anything.
 *
 * What this returns is what the platform **believes** it has placed, which is
 * what it is responsible for staying inside. Where that differs from what a
 * machine is actually running, the difference is drift, and finding it is a
 * reconciliation problem rather than a scheduling one.
 *
 * Only counts what is occupying a host now. A stopped runtime and a finished
 * deployment have given their capacity back; counting them would have the
 * platform refuse work because of containers that no longer exist.
 */
export class DatabasePlacementSource implements PlacementSource {
  constructor(
    private readonly db: Database,
    /**
     * What a deployment is allowed, which is not recorded per deployment.
     *
     * A runtime carries its own ceilings on its row, because they were chosen
     * when it was created and a later configuration change must not retroactively
     * describe a container that is already running. A deployment does not, so the
     * current configuration is used — which is right often and wrong for a
     * deployment that outlived a change to it. Worth knowing, and much better
     * than not counting deployments at all.
     */
    private readonly deploymentLimits: { cpuMillicores: number; memoryMb: number },
  ) {}

  async currentLoad(): Promise<Map<string, HostLoad>> {
    const loads = new Map<string, HostLoad>();

    const add = (host: string | null, cpu: number, memory: number): void => {
      // A row with no host predates hosts existing, and belongs to whichever one
      // was the only host at the time. The scheduler is given the default under
      // that name, so it is counted there.
      const key = host ?? '';
      const held = loads.get(key) ?? { workloads: 0, cpuMillicores: 0, memoryMb: 0 };

      loads.set(key, {
        workloads: held.workloads + 1,
        cpuMillicores: held.cpuMillicores + cpu,
        memoryMb: held.memoryMb + memory,
      });
    };

    const runtimes = await this.db.runtime.findMany({
      // Everything that is on a host or on its way onto one. REQUESTED is
      // included deliberately: a runtime whose container is being created is
      // already spoken for, and leaving it out would let a burst of starts all
      // choose the same host.
      where: { status: { in: ['REQUESTED', 'CREATING', 'STARTING', 'RUNNING', 'STOPPING'] } },
      select: { executionHost: true, cpuMillicores: true, memoryMb: true },
    });

    for (const runtime of runtimes) {
      add(runtime.executionHost, runtime.cpuMillicores, runtime.memoryMb);
    }

    const deployments = await this.db.deployment.findMany({
      where: {
        OR: [
          // A build occupies a container whatever it builds.
          { status: { in: ['REQUESTED', 'BUILDING', 'STARTING'] } },
          // A published static site occupies nothing on any host.
          { status: { in: ['RUNNING', 'STOPPING'] }, target: 'SERVER' },
        ],
      },
      select: { executionHost: true },
    });

    for (const deployment of deployments) {
      add(
        deployment.executionHost,
        this.deploymentLimits.cpuMillicores,
        this.deploymentLimits.memoryMb,
      );
    }

    return loads;
  }

  async drainedHosts(): Promise<Set<string>> {
    const rows = await this.db.executionHostDrain.findMany({ select: { hostName: true } });
    return new Set(rows.map((row) => row.hostName));
  }
}
