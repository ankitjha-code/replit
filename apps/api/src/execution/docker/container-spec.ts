import type Docker from 'dockerode';
import { PREVIEW_CANDIDATE_PORTS } from '@platform/shared';
import type { ProvisionRequest, ProviderState, WorkloadKind } from '../provider.js';

/**
 * What a runtime container is, expressed as data.
 *
 * Kept separate from the code that talks to the daemon and free of any I/O, so
 * the properties that matter can be asserted directly rather than inferred
 * from a container that happens to be running. Every security decision the
 * provider makes is visible in one object here.
 */

export interface ContainerSpecOptions {
  /** Where the project's files live inside the container. */
  workspacePath: string;
  /**
   * The network this workload is attached to.
   *
   * One per project, not one for all of them. Every project on a single network
   * can reach every other project on it, by container name, with nothing in
   * between: a bridge network is a local network, and being on one is being able
   * to talk to everything else on it. A per-project network is what makes the
   * isolation the rest of this file describes true of projects and not only of
   * the host.
   */
  network: string;
  /** Hardening limits that are not resource ceilings. See below. */
  hardening: HardeningOptions;
  /**
   * Whether the preview ports are published on the host.
   *
   * **Publishing breaks project isolation for exactly those ports.** Verified
   * against a real daemon: a port published by one container — even bound only
   * to the host's loopback — is reachable from containers on *other* Docker
   * networks, while an unpublished port on the same container is not. The
   * preview ports are where people's applications listen, so publishing them
   * lets any project connect to any other project's running app.
   *
   * It is only ever needed on Docker Desktop, where the host cannot reach a
   * container's own address and a published port is the only way in. On Linux
   * the platform dials the container's address directly and nothing is
   * published. The caller decides; this file only obeys.
   */
  publishPorts: boolean;
}

/**
 * Limits that are not about how much of the machine a workload gets.
 *
 * The resource ceilings elsewhere in this file stop a workload consuming the
 * host. These stop it doing things: opening more files than a process
 * legitimately needs, writing an executable into a directory it can write to,
 * being killed last when the host runs out of memory.
 */
export interface HardeningOptions {
  /**
   * Open files and processes, as the kernel counts them.
   *
   * Separate from the process limit above, which the container runtime enforces
   * as a cgroup and which counts differently. A descriptor leak exhausts a host
   * long before it exhausts a memory limit, and it does it to every other
   * container on the machine rather than only to itself.
   */
  maxOpenFiles: number;
  maxProcesses: number;

  /**
   * Who a workload runs as, written `uid:gid`, or null to leave it as root.
   *
   * The largest thing capability dropping does not fix. Every capability can be
   * dropped and the process inside is still uid 0, which means every file the
   * image ships is writable by it, every package manager runs unrestricted, and
   * any future container-runtime escape starts from root rather than from
   * nobody.
   *
   * Numeric rather than a name on purpose. A name has to exist in the image's
   * own `/etc/passwd`, and it does not exist in all of them — `node` images have
   * a `node` user at 1000, the official Python images have none. A numeric id
   * always works: the kernel does not need the name, and the only cost is a
   * shell prompt that says `I have no name!`.
   *
   * Null is the escape hatch for an image that genuinely cannot run unprivileged.
   * It is configuration rather than a code path, so choosing it is visible.
   */
  workloadUser: string | null;

  /**
   * A writable home directory for the workload, outside its project files.
   *
   * Package managers, compilers and language runtimes all write caches and
   * configuration into `$HOME`. Without one that is writable, a non-root
   * workload cannot install a dependency — which is the failure that makes
   * people turn the whole measure off.
   *
   * Not the workspace: a cache written there would appear in the file explorer,
   * be copied into every snapshot, and be deployed. Not `/tmp` either, which is
   * a bounded tmpfs and therefore memory — a dependency install would either
   * fill it or fill the host's RAM.
   */
  homePath: string;

  /**
   * A hard ceiling on what the workload may write, in megabytes, enforced by the
   * container runtime — or null to rely on the platform's measurement instead.
   *
   * Only some storage setups enforce this: overlay2 on XFS mounted with project
   * quotas, btrfs, and zfs. Others refuse it, and Docker's containerd snapshotter
   * accepts it and silently ignores it (verified: a container limited to 50 MB
   * wrote 120 MB). So it is opt-in, and the platform measures every workload's
   * disk regardless and stops one that goes over.
   */
  storageLimitMb?: number | null;

  /**
   * The OCI runtime a workload runs under, or null for the daemon's default.
   *
   * `runsc` is gVisor: every system call the workload makes is answered by a
   * user-space kernel rather than the host's, so a kernel bug is no longer a
   * way out. It must be installed on the host and registered with the daemon.
   */
  ociRuntime?: string | null;

  /**
   * How much writable temporary space a workload gets, in megabytes.
   *
   * A tmpfs rather than the image's own `/tmp`, so that what a workload writes
   * there is bounded, is not on the host's disk, and goes when the container
   * does. Mounted `nosuid` and `nodev`: a setuid binary written into a temporary
   * directory is one of the oldest ways out of a weakly confined process.
   *
   * Deliberately **not** `noexec`. A great many build tools unpack and run
   * something from a temporary directory as a matter of course, and a hardening
   * measure that breaks ordinary builds is one an operator turns off.
   */
  tmpMegabytes: number;
}

/** Label namespace, so the platform can find and clean up only its own. */
export const LABEL_MANAGED = 'platform.managed';
export const LABEL_RUNTIME = 'platform.runtime.id';
export const LABEL_PROJECT = 'platform.project.id';
/**
 * What the container is for.
 *
 * Recorded because a sweep for abandoned development runtimes must not be able
 * to find a deployment: one is disposable by design and the other is somebody's
 * running site, and a query that could not tell them apart would eventually
 * remove the wrong one.
 */
export const LABEL_KIND = 'platform.kind';
export const LABEL_DEPLOYMENT = 'platform.deployment.id';

const MEGABYTE = 1024 * 1024;
/** Docker expresses CPU as billionths of a core; a millicore is a millionth. */
const NANOCPUS_PER_MILLICORE = 1_000_000;

/**
 * A name that says what the container is without revealing anything.
 *
 * The workload identifier rather than the project's name: a container name is
 * visible to anyone who can list containers on the host, and a project's name
 * is the user's text.
 */
export function containerName(kind: WorkloadKind, workloadId: string): string {
  return `platform-${kind}-${workloadId}`;
}

/**
 * The container to create for one runtime.
 *
 * The decisions worth naming:
 *
 * - **Nothing is mounted.** No binds, no volumes. This is what makes it
 *   impossible for a workload to be handed the container runtime's socket,
 *   which would let it create a privileged container and take the host. The
 *   project's files are copied in afterwards rather than shared from disk.
 * - **Every capability is dropped**, and privilege escalation is refused, so a
 *   setuid binary inside the image cannot be used to regain what was dropped.
 * - **Swap is pinned to the memory limit.** Without that, a container over its
 *   memory ceiling swaps instead of being stopped, and the limit buys nothing.
 * - **The process limit is separate** because a fork bomb costs neither CPU
 *   quota nor memory quota to write.
 * - **The command is a sleep.** A development runtime is an environment, not a
 *   program: what runs in it arrives later as an exec. An image's own
 *   entrypoint is overridden because several of them exit immediately.
 * - **Nothing restarts it.** The control plane decides what should be running;
 *   a container that comes back on its own would contradict the database. That
 *   holds for a deployment too, which is a real limitation rather than an
 *   oversight: a deployed process that crashes stays down until somebody
 *   redeploys, and nothing yet notices that it has. Reconciliation is its own
 *   piece of work.
 * - **It is alone on its network.** One network per project rather than one for
 *   all of them: a bridge network is a local network, and everything on it can
 *   reach everything else on it by name. Without this, a project's code could
 *   port-scan and connect to every other project on the installation, which no
 *   amount of capability dropping prevents.
 * - **The kernel's own ceilings are set**, not only the container runtime's. A
 *   descriptor leak exhausts a host long before it exhausts a memory limit, and
 *   it does it to every other container on the machine.
 * - **`/tmp` is a bounded tmpfs**, mounted `nosuid` and `nodev`. A setuid binary
 *   written into a writable temporary directory is one of the oldest ways out of
 *   a weakly confined process.
 * - **Sensitive kernel interfaces are masked and read-only**, stated here rather
 *   than inherited. The container runtime's defaults already do this; writing
 *   them down means the guarantee survives a daemon whose defaults change and
 *   makes it something a reader can check rather than assume.
 * - **It is killed first.** Under host memory pressure the kernel picks a
 *   victim, and a workload running somebody else's code should be chosen before
 *   the control plane that is supposed to clean up after it.
 */
export function containerCreateOptions(
  request: ProvisionRequest,
  options: ContainerSpecOptions,
): Docker.ContainerCreateOptions {
  return {
    name: containerName(request.kind, request.workloadId),
    Image: request.image,
    ExposedPorts: Object.fromEntries(PREVIEW_CANDIDATE_PORTS.map((port) => [`${port}/tcp`, {}])),
    Entrypoint: ['/bin/sh', '-c'],
    /*
     * What the container runs.
     *
     * A development runtime sleeps in a loop, because it is an environment and
     * not a program: what runs in it arrives later as an exec. `sleep infinity`
     * is avoided because BusyBox does not accept it and several of these images
     * are BusyBox based.
     *
     * A workload given a command runs that instead, and ends when it ends. For a
     * deployment that is the point: a site whose process died should be a
     * container that exited, not one still sitting there looking healthy.
     */
    Cmd: [request.command ?? 'while true; do sleep 86400; done'],
    WorkingDir: options.workspacePath,

    /*
     * Not root, when the installation allows it.
     *
     * This is the container's own idle process, which is a sleep the platform
     * wrote — so making it unprivileged costs nothing. Everything a person
     * actually runs arrives later as an exec, and those carry the same user.
     *
     * The one thing that still needs root is preparing the workspace and the
     * home directory so this user can write to them, which happens as an
     * explicit root exec at seeding time rather than by leaving the container
     * privileged.
     */
    ...(options.hardening.workloadUser ? { User: options.hardening.workloadUser } : {}),

    Env: [
      ...Object.entries(request.env).map(([key, value]) => `${key}=${value}`),
      // Last, so a project cannot point its own HOME somewhere it cannot write
      // and then report that the platform is broken.
      `HOME=${options.hardening.homePath}`,
    ],
    Labels: {
      [LABEL_MANAGED]: 'true',
      [LABEL_KIND]: request.kind,
      [request.kind === 'runtime' ? LABEL_RUNTIME : LABEL_DEPLOYMENT]: request.workloadId,
      [LABEL_PROJECT]: request.projectId,
    },
    // Kept open so a terminal can attach to this container later without
    // recreating it.
    Tty: true,
    OpenStdin: true,
    HostConfig: {
      // Deliberately empty. See the note above: this is the line that keeps
      // the Docker socket out of user workloads.
      Binds: [],
      Mounts: [],
      NetworkMode: options.network,
      /*
       * Published only when there is no other way in, and then to loopback.
       *
       * On Docker Desktop a container's own address is not routable from the
       * host, so the proxy needs a published port; it is pinned to 127.0.0.1
       * with the port left for the kernel to pick. Everywhere else nothing is
       * published at all, because a published port is reachable from other
       * projects' networks — see `publishPorts` above.
       */
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

      /*
       * Bounded temporary space, on a filesystem of its own.
       *
       * `nosuid` stops a setuid binary written here from being useful, `nodev`
       * stops a device node being made here, and the size bound stops a
       * workload filling the host's disk through a directory everything expects
       * to be writable. Not `noexec`: too many build tools legitimately run
       * something out of a temporary directory, and a measure that breaks
       * ordinary builds is one that gets turned off.
       */
      Tmpfs: {
        // Mode stated rather than inherited. A non-root workload has to be able
        // to write here — the run wrapper records its process id in /tmp — and
        // a daemon whose default differs would break that silently.
        '/tmp': `rw,nosuid,nodev,mode=1777,size=${options.hardening.tmpMegabytes}m`,
      },

      /*
       * The kernel's own ceilings, beside the container runtime's.
       *
       * A process limit as a cgroup and a process limit as a rlimit count
       * different things, and a descriptor leak is bounded by neither the
       * memory limit nor the pids limit. Both of these exhaust a host rather
       * than a container, which is why they are worth setting even though a
       * workload already has a memory ceiling.
       */
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

      /*
       * Kernel interfaces that must not be readable or writable from inside.
       *
       * The container runtime masks these by default. They are written out
       * because a default is a promise somebody else is keeping: stating them
       * makes the guarantee survive a daemon configured differently, and makes
       * it something a reader of this file can check rather than assume.
       */
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

      /*
       * Chosen first when the host runs out of memory.
       *
       * The kernel picks a victim under pressure, and left alone it picks by
       * size — which on a busy host may well be the control plane rather than
       * the workload that caused the problem. Nudging a workload's score up
       * makes the thing running somebody else's code the one that goes.
       */
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
      // Removed by the platform when it decides to, so a container that
      // exited can still be inspected to find out why.
      AutoRemove: false,
    },
  };
}

/**
 * What Docker says about a container, in the platform's terms.
 *
 * Deliberately coarser than Docker's own state. "Restarting" and "paused" both
 * mean the workload is not usable and not gone, which is what `created`
 * conveys; what to do about it is the control plane's decision, not this
 * mapping's.
 */
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

/**
 * Docker's own statistics, in the platform's terms.
 *
 * Free of I/O so the arithmetic can be checked directly, which matters because
 * none of it is obvious:
 *
 * - **Processor use is a delta, not a level.** Docker reports cumulative
 *   nanoseconds consumed, both by the container and by the whole system, and
 *   the only meaningful number is the ratio of the two changes since the last
 *   reading. A single sample therefore says nothing, and Docker's own
 *   non-streaming call supplies the previous one alongside it.
 * - **Memory needs the cache subtracted.** The raw usage includes page cache,
 *   which the kernel reclaims under pressure; reporting it as used makes every
 *   container that has read a file look close to its limit.
 * - **Anything missing stays missing.** A field Docker did not report comes
 *   back null rather than zero, because zero is a measurement and null is the
 *   absence of one.
 */
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

/** The shape of the statistics payload, as much of it as is read. */
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

  /*
   * The first reading after a container starts has no previous one.
   *
   * Docker reports both cumulative counters as equal, so the deltas are zero
   * and the ratio is undefined. Null rather than zero: nothing was measured,
   * and a flat line at the bottom of a chart is a claim.
   */
  if (systemDelta <= 0 || usedDelta < 0) return null;

  /*
   * The system counter covers every core, so the ratio has to be multiplied
   * back up by how many there are to express "share of one core".
   */
  const cores = stats.cpu_stats?.online_cpus ?? 1;
  return Math.round((usedDelta / systemDelta) * cores * 1000);
}

function memoryBytes(stats: DockerStats): number | null {
  const usage = stats.memory_stats?.usage;
  if (typeof usage !== 'number') return null;

  /*
   * Page cache is subtracted, under whichever name this kernel reports it.
   *
   * cgroup v1 calls it `cache` and v2 calls it `inactive_file`. Either way it
   * is memory the kernel will reclaim rather than memory the program needs, and
   * counting it makes every container that has read a file look nearly full.
   */
  const cache = stats.memory_stats?.stats?.inactive_file ?? stats.memory_stats?.stats?.cache ?? 0;

  return Math.max(usage - cache, 0);
}
