import type { ResourceLimits } from '@platform/shared';
import type { Logger } from 'pino';
import { AppError } from '../errors/app-error.js';
import type { ExecutionHostConfig } from './hosts.js';

export interface HostLoad {
  workloads: number;
  cpuMillicores: number;
  memoryMb: number;
}

export interface HostPlacement {
  host: ExecutionHostConfig;
  load: HostLoad;
  remaining: HostLoad;
}

const EMPTY: HostLoad = { workloads: 0, cpuMillicores: 0, memoryMb: 0 };

export function choosePlacement(
  hosts: readonly ExecutionHostConfig[],
  loads: ReadonlyMap<string, HostLoad>,
  request: ResourceLimits,
): HostPlacement {
  const schedulable = hosts.filter((host) => host.schedulable);

  if (schedulable.length === 0) {
    throw new AppError(
      'RUNTIME_UNAVAILABLE',
      'No execution host is accepting new work at the moment.',
      { expose: true },
    );
  }

  const candidates = schedulable
    .map((host) => {
      const load = loads.get(host.name) ?? EMPTY;

      return {
        host,
        load,
        remaining: {
          workloads: host.maxWorkloads - load.workloads,
          cpuMillicores: host.cpuMillicores - load.cpuMillicores,
          memoryMb: host.memoryMb - load.memoryMb,
        },
      };
    })
    .filter(
      (candidate) =>
        candidate.remaining.workloads >= 1 &&
        candidate.remaining.cpuMillicores >= request.cpuMillicores &&
        candidate.remaining.memoryMb >= request.memoryMb,
    );

  if (candidates.length === 0) {
    throw new AppError(
      'RUNTIME_UNAVAILABLE',
      'Every execution host is full, so there is nowhere to run this right now. Stop something you are not using, or ask for more capacity.',
      { expose: true },
    );
  }

  let best = candidates[0]!;
  let bestScore = freeFraction(best);

  for (const candidate of candidates.slice(1)) {
    const score = freeFraction(candidate);
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }

  return {
    host: best.host,
    load: best.load,
    remaining: {
      workloads: best.remaining.workloads - 1,
      cpuMillicores: best.remaining.cpuMillicores - request.cpuMillicores,
      memoryMb: best.remaining.memoryMb - request.memoryMb,
    },
  };
}

function freeFraction(candidate: { host: ExecutionHostConfig; remaining: HostLoad }): number {
  return Math.min(
    candidate.remaining.cpuMillicores / candidate.host.cpuMillicores,
    candidate.remaining.memoryMb / candidate.host.memoryMb,
    candidate.remaining.workloads / candidate.host.maxWorkloads,
  );
}

export interface PlacementSource {
  currentLoad(): Promise<Map<string, HostLoad>>;
  drainedHosts?(): Promise<Set<string>>;
}

export function describeLoad(host: ExecutionHostConfig, load: HostLoad, log?: Logger): string {
  const text = `${load.workloads}/${host.maxWorkloads} workloads, ${load.cpuMillicores}/${host.cpuMillicores} millicores, ${load.memoryMb}/${host.memoryMb} MB placed`;
  log?.debug({ host: host.name, ...load }, 'execution host load');
  return text;
}
