import type { Database } from '../db/client.js';
import type { HostLoad, PlacementSource } from './scheduler.js';

export class DatabasePlacementSource implements PlacementSource {
  constructor(
    private readonly db: Database,
    private readonly deploymentLimits: { cpuMillicores: number; memoryMb: number },
  ) {}

  async currentLoad(): Promise<Map<string, HostLoad>> {
    const loads = new Map<string, HostLoad>();

    const add = (host: string | null, cpu: number, memory: number): void => {
      const key = host ?? '';
      const held = loads.get(key) ?? { workloads: 0, cpuMillicores: 0, memoryMb: 0 };

      loads.set(key, {
        workloads: held.workloads + 1,
        cpuMillicores: held.cpuMillicores + cpu,
        memoryMb: held.memoryMb + memory,
      });
    };

    const runtimes = await this.db.runtime.findMany({
      where: { status: { in: ['REQUESTED', 'CREATING', 'STARTING', 'RUNNING', 'STOPPING'] } },
      select: { executionHost: true, cpuMillicores: true, memoryMb: true },
    });

    for (const runtime of runtimes) {
      add(runtime.executionHost, runtime.cpuMillicores, runtime.memoryMb);
    }

    const deployments = await this.db.deployment.findMany({
      where: {
        OR: [
          { status: { in: ['REQUESTED', 'BUILDING', 'STARTING'] } },
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
