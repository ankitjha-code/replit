import type Docker from 'dockerode';
import { PREVIEW_CANDIDATE_PORTS } from '@platform/shared';
import type { ProvisionRequest, ProviderState, WorkloadKind } from '../provider.js';

export interface ContainerSpecOptions {
  workspacePath: string;
  network: string;
  hardening: HardeningOptions;
  publishPorts: boolean;
}

export interface HardeningOptions {
  maxOpenFiles: number;
  maxProcesses: number;

  workloadUser: string | null;

  homePath: string;

  storageLimitMb?: number | null;

  ociRuntime?: string | null;

  tmpMegabytes: number;
}

export const LABEL_MANAGED = 'platform.managed';
export const LABEL_RUNTIME = 'platform.runtime.id';
export const LABEL_PROJECT = 'platform.project.id';
export const LABEL_KIND = 'platform.kind';
export const LABEL_DEPLOYMENT = 'platform.deployment.id';

const MEGABYTE = 1024 * 1024;
const NANOCPUS_PER_MILLICORE = 1_000_000;

export function containerName(kind: WorkloadKind, workloadId: string): string {
  return `platform-${kind}-${workloadId}`;
}

export function containerCreateOptions(
  request: ProvisionRequest,
  options: ContainerSpecOptions,
): Docker.ContainerCreateOptions {
  return {
    name: containerName(request.kind, request.workloadId),
    Image: request.image,
    ExposedPorts: Object.fromEntries(PREVIEW_CANDIDATE_PORTS.map((port) => [`${port}/tcp`, {}])),
    Entrypoint: ['/bin/sh', '-c'],
    Cmd: [request.command ?? 'while true; do sleep 86400; done'],
    WorkingDir: options.workspacePath,

    ...(options.hardening.workloadUser ? { User: options.hardening.workloadUser } : {}),

    Env: [
      ...Object.entries(request.env).map(([key, value]) => `${key}=${value}`),
      `HOME=${options.hardening.homePath}`,
    ],
    Labels: {
      [LABEL_MANAGED]: 'true',
      [LABEL_KIND]: request.kind,
      [request.kind === 'runtime' ? LABEL_RUNTIME : LABEL_DEPLOYMENT]: request.workloadId,
      [LABEL_PROJECT]: request.projectId,
    },
    Tty: true,
    OpenStdin: true,
    HostConfig: {
      Binds: [],
      Mounts: [],
      NetworkMode: options.network,
      PortBindings: options.publishPorts
        ? Object.fromEntries(
            PREVIEW_CANDIDATE_PORTS.map((port) => [
              `${port}/tcp`,
              [{ HostIp: '127.0.0.1', HostPort: '' }],
            ]),
          )
        : {},
      Privileged: false,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges'],

      Tmpfs: {
        '/tmp': `rw,nosuid,nodev,mode=1777,size=${options.hardening.tmpMegabytes}m`,
      },

      Ulimits: [
        {
          Name: 'nofile',
          Soft: options.hardening.maxOpenFiles,
          Hard: options.hardening.maxOpenFiles,
        },
        {
          Name: 'nproc',
          Soft: options.hardening.maxProcesses,
          Hard: options.hardening.maxProcesses,
        },
      ],

      MaskedPaths: [
        '/proc/asound',
        '/proc/acpi',
        '/proc/kcore',
        '/proc/keys',
        '/proc/latency_stats',
        '/proc/timer_list',
        '/proc/timer_stats',
        '/proc/sched_debug',
        '/proc/scsi',
        '/sys/firmware',
        '/sys/devices/virtual/powercap',
      ],
      ReadonlyPaths: ['/proc/bus', '/proc/fs', '/proc/irq', '/proc/sys', '/proc/sysrq-trigger'],

      OomScoreAdj: 500,
      NanoCpus: request.limits.cpuMillicores * NANOCPUS_PER_MILLICORE,
      Memory: request.limits.memoryMb * MEGABYTE,
      MemorySwap: request.limits.memoryMb * MEGABYTE,
      PidsLimit: request.limits.pidsLimit,
      ...(options.hardening.storageLimitMb
        ? { StorageOpt: { size: `${String(options.hardening.storageLimitMb)}M` } }
        : {}),
      ...(options.hardening.ociRuntime ? { Runtime: options.hardening.ociRuntime } : {}),
      OomKillDisable: false,
      RestartPolicy: { Name: 'no' },
      AutoRemove: false,
    },
  };
}

export function providerState(inspected: {
  State?: { Running?: boolean; Status?: string };
}): ProviderState {
  const state = inspected.State;
  if (!state) return 'absent';
  if (state.Running === true) return 'running';

  switch (state.Status) {
    case 'exited':
    case 'dead':
      return 'exited';
    default:
      return 'created';
  }
}

export function workloadStats(stats: DockerStats): {
  cpuMillicores: number | null;
  memoryBytes: number | null;
  pids: number | null;
} {
  return {
    cpuMillicores: cpuMillicores(stats),
    memoryBytes: memoryBytes(stats),
    pids: typeof stats.pids_stats?.current === 'number' ? stats.pids_stats.current : null,
  };
}

export interface DockerStats {
  cpu_stats?: {
    cpu_usage?: { total_usage?: number };
    system_cpu_usage?: number;
    online_cpus?: number;
  };
  precpu_stats?: {
    cpu_usage?: { total_usage?: number };
    system_cpu_usage?: number;
  };
  memory_stats?: {
    usage?: number;
    stats?: { cache?: number; inactive_file?: number };
  };
  pids_stats?: { current?: number };
}

function cpuMillicores(stats: DockerStats): number | null {
  const used = stats.cpu_stats?.cpu_usage?.total_usage;
  const usedBefore = stats.precpu_stats?.cpu_usage?.total_usage;
  const system = stats.cpu_stats?.system_cpu_usage;
  const systemBefore = stats.precpu_stats?.system_cpu_usage;

  if (
    typeof used !== 'number' ||
    typeof usedBefore !== 'number' ||
    typeof system !== 'number' ||
    typeof systemBefore !== 'number'
  ) {
    return null;
  }

  const usedDelta = used - usedBefore;
  const systemDelta = system - systemBefore;

  if (systemDelta <= 0 || usedDelta < 0) return null;

  const cores = stats.cpu_stats?.online_cpus ?? 1;
  return Math.round((usedDelta / systemDelta) * cores * 1000);
}

function memoryBytes(stats: DockerStats): number | null {
  const usage = stats.memory_stats?.usage;
  if (typeof usage !== 'number') return null;

  const cache = stats.memory_stats?.stats?.inactive_file ?? stats.memory_stats?.stats?.cache ?? 0;

  return Math.max(usage - cache, 0);
}
