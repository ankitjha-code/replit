import type { ResourceLimits } from '@platform/shared';
import type { Logger } from 'pino';
import { AppError } from '../errors/app-error.js';
import type { ExecutionHostConfig } from './hosts.js';

/**
 * Deciding which machine a workload goes on.
 *
 * Only matters once there is more than one, and it is the reason having more
 * than one is useful: without a scheduler a second host is a machine nothing
 * ever lands on.
 *
 * ## What it schedules against
 *
 * The **limits a workload was given**, not what it is using. A container that
 * has been promised a gigabyte has that gigabyte whether or not it is touching
 * it, and placing against measured use would let a host be filled with
 * workloads that are all idle right now and all entitled to more than it has.
 * Measured use is section 6ad's business; this is capacity planning.
 *
 * ## Why it refuses rather than overcommitting
 *
 * A platform that placed a workload on a full host would produce a container the
 * kernel kills under memory pressure, which surfaces as somebody's project dying
 * mid-build for no reason they can see. "There is no room" is a worse answer to
 * receive and a far better one to be given.
 */

/** What is already placed on a host, as the platform recorded it. */
export interface HostLoad {
  workloads: number;
  cpuMillicores: number;
  memoryMb: number;
}

export interface HostPlacement {
  host: ExecutionHostConfig;
  load: HostLoad;
  /** What would be left after this workload, for logging a decision. */
  remaining: HostLoad;
}

const EMPTY: HostLoad = { workloads: 0, cpuMillicores: 0, memoryMb: 0 };

/**
 * Chooses a host for a workload, or refuses.
 *
 * **Most free capacity wins**, measured as the smaller of the two fractions a
 * host has left. Not round-robin, which ignores size and fills the small host
 * first; not first-fit, which packs one host solid before touching the next and
 * makes a single machine's failure take everything with it.
 *
 * Spreading is the right default for this platform because its workloads are
 * long-lived and unpredictable: a project's container may idle for a week and
 * then compile something. Packing would be right if the goal were to empty hosts
 * and switch them off, which is not a goal here.
 */
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
    /*
     * Refused, rather than placed somewhere that cannot hold it.
     *
     * The message says what is wrong and not what to do about it, because what
     * to do about it is an operator's decision — stop something, add a host,
     * raise a budget — and guessing which would be advice the platform cannot
     * support.
     */
    throw new AppError(
      'RUNTIME_UNAVAILABLE',
      'Every execution host is full, so there is nowhere to run this right now. Stop something you are not using, or ask for more capacity.',
      { expose: true },
    );
  }

  /*
   * The host with the most room, where "most" is its tightest dimension.
   *
   * Using the smaller of the two fractions rather than either alone: a host with
   * plenty of memory and no processor left is full, and a scheduler that ranked
   * on memory would keep choosing it.
   */
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

/** How free a host is, judged by whichever of its dimensions is tightest. */
function freeFraction(candidate: { host: ExecutionHostConfig; remaining: HostLoad }): number {
  return Math.min(
    candidate.remaining.cpuMillicores / candidate.host.cpuMillicores,
    candidate.remaining.memoryMb / candidate.host.memoryMb,
    candidate.remaining.workloads / candidate.host.maxWorkloads,
  );
}

/**
 * What the platform has placed on each host.
 *
 * Read from the platform's own records rather than from the hosts themselves,
 * and that is the important part. Asking a machine what it is running would
 * count things the platform did not put there and would make scheduling depend
 * on every host answering; asking the database says what this platform believes
 * it has placed, which is what it is responsible for staying inside.
 *
 * The difference between the two is drift, and finding it is a reconciliation
 * problem rather than a scheduling one.
 */
export interface PlacementSource {
  currentLoad(): Promise<Map<string, HostLoad>>;
  /** Hosts an operator has drained. Nothing new is placed on them. */
  drainedHosts?(): Promise<Set<string>>;
}

/** Sums what one host is carrying, for logging and for the health page. */
export function describeLoad(host: ExecutionHostConfig, load: HostLoad, log?: Logger): string {
  const text = `${load.workloads}/${host.maxWorkloads} workloads, ${load.cpuMillicores}/${host.cpuMillicores} millicores, ${load.memoryMb}/${host.memoryMb} MB placed`;
  log?.debug({ host: host.name, ...load }, 'execution host load');
  return text;
}
