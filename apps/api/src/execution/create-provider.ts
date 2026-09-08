import type { Logger } from 'pino';
import type { Env } from '../config/env.js';
import { createDockerClient, DockerExecutionProvider } from './docker/docker-provider.js';
import type { DockerProviderOptions } from './docker/docker-provider.js';
import { parseExecutionHosts, type ExecutionHostConfig } from './hosts.js';
import type { ExecutionProvider } from './provider.js';
import { RoutingExecutionProvider } from './routing-provider.js';
import type { PlacementSource } from './scheduler.js';
import { UnavailableExecutionProvider } from './unavailable-provider.js';

/**
 * Chooses the execution backend from configuration.
 *
 * The switch is exhaustive over the configured values, so adding a provider to
 * the environment schema without building one is a compile error rather than a
 * runtime surprise. That is deliberate: the failure mode this guards against is
 * an installation configured for an execution backend that silently falls back
 * to doing nothing.
 *
 * With `EXECUTION_HOSTS` set, the same Docker provider is built once per host
 * and put behind a router. Nothing above the port changes, which is what the
 * port was for.
 */
export function createExecutionProvider(
  config: Env,
  log: Logger,
  /**
   * What the platform has already placed, for the scheduler.
   *
   * Absent when there is no database, which is the case in unit tests and in a
   * control plane that cannot run anything anyway. Without it there is nothing
   * to schedule against, so a multi-host configuration falls back to its first
   * host and says so.
   */
  placement?: PlacementSource,
): ExecutionProvider {
  switch (config.EXECUTION_PROVIDER) {
    case 'none':
      return new UnavailableExecutionProvider();

    case 'docker': {
      const hosts = resolveHosts(config);

      const providers = new Map<string, ExecutionProvider>(
        hosts.map((host) => [
          host.name,
          new DockerExecutionProvider(
            createDockerClient(host.socketPath ?? host.url ?? config.DOCKER_SOCKET_PATH),
            dockerOptions(config),
            log.child({ host: host.name }),
          ),
        ]),
      );

      /*
       * One host and nothing to schedule against is the old arrangement.
       *
       * Returned unrouted rather than wrapped, so a single-machine installation
       * keeps producing plain container identifiers and reads exactly as it did
       * before hosts existed. The router's decode handles either kind, so this
       * is a simplification rather than a second code path with its own bugs.
       */
      if (hosts.length === 1 && !placement) return providers.values().next().value!;

      if (!placement) {
        log.warn(
          { hosts: hosts.length },
          'several execution hosts are configured but nothing can say what is placed on them; using the first',
        );
        return providers.values().next().value!;
      }

      return new RoutingExecutionProvider(
        {
          hosts,
          providers,
          placement,
          // Anything created before hosts existed belongs to whichever one was
          // the only host at the time, which is the first in the list.
          defaultHost: hosts[0]!.name,
        },
        log,
      );
    }

    default:
      return assertNever(config.EXECUTION_PROVIDER);
  }
}

/**
 * The hosts this installation has.
 *
 * One implicit host when none is declared, named for the single socket it has
 * always used. Its capacity is the runtime ceiling multiplied by how many
 * runtimes an installation was already willing to run, which is a guess — and a
 * declared one, which is the point: an installation that cares sets
 * EXECUTION_HOSTS and stops guessing.
 */
export function resolveHosts(config: Env): ExecutionHostConfig[] {
  if (config.EXECUTION_HOSTS) return parseExecutionHosts(config.EXECUTION_HOSTS);

  return [
    {
      name: 'local',
      ...(config.DOCKER_SOCKET_PATH ? { socketPath: config.DOCKER_SOCKET_PATH } : {}),
      cpuMillicores: config.RUNTIME_CPU_MILLICORES * config.MAX_WORKLOADS_PER_HOST,
      memoryMb: config.RUNTIME_MEMORY_MB * config.MAX_WORKLOADS_PER_HOST,
      maxWorkloads: config.MAX_WORKLOADS_PER_HOST,
      schedulable: true,
    },
  ];
}

/** The same options for every host: they differ in where they are, not in how. */
function dockerOptions(config: Env): DockerProviderOptions {
  return {
    /*
     * A prefix, not a network. Each project gets one of its own beneath it, so
     * a project's code cannot reach another project's container by name.
     */
    networkPrefix: config.RUNTIME_NETWORK,
    /*
     * The database server, put back on each project's network deliberately.
     *
     * Isolating projects from each other takes away the route to it as well.
     * Naming it here is what puts it back, one project at a time, rather than
     * leaving every project on one network and hoping.
     */
    ...(config.USER_DATABASE_ADMIN_URL
      ? { sharedServiceContainer: config.USER_DATABASE_CONTAINER_HOST }
      : {}),
    workspacePath: config.RUNTIME_WORKSPACE_PATH,
    terminalReplayBytes: config.TERMINAL_SCROLLBACK_BYTES,
    publishMode: config.RUNTIME_PUBLISH_PORTS,
    subnetPool: {
      base: config.RUNTIME_NETWORK_POOL,
      prefixLength: config.RUNTIME_NETWORK_PREFIX_LENGTH,
    },
    hardening: {
      maxOpenFiles: config.RUNTIME_MAX_OPEN_FILES,
      maxProcesses: config.RUNTIME_PIDS_LIMIT,
      tmpMegabytes: config.RUNTIME_TMP_MB,
      workloadUser: config.RUNTIME_RUN_AS_ROOT
        ? null
        : `${String(config.RUNTIME_WORKLOAD_UID)}:${String(config.RUNTIME_WORKLOAD_GID)}`,
      homePath: config.RUNTIME_WORKLOAD_HOME,
      storageLimitMb: config.DISK_LIMIT_MODE === 'enforce' ? config.RUNTIME_DISK_MB : null,
      ociRuntime: config.RUNTIME_OCI_RUNTIME ?? null,
    },
    pullTimeoutMs: config.RUNTIME_IMAGE_PULL_TIMEOUT_MS,
    read: {
      maxFileBytes: config.FILE_MAX_BYTES,
      maxTotalBytes: config.PROJECT_MAX_BYTES,
      maxFiles: config.PROJECT_MAX_FILES,
      // Reading a workspace back into a project: the exclusion list is exactly
      // what it is for.
      applyExclusions: true,
    },
    collect: {
      maxFileBytes: config.DEPLOYMENT_MAX_FILE_BYTES,
      maxTotalBytes: config.DEPLOYMENT_MAX_ARTIFACT_BYTES,
      maxFiles: config.DEPLOYMENT_MAX_FILES,
      // Collecting a build's output: the caller named the directory, and the
      // exclusion list contains the very names a build produces.
      applyExclusions: false,
    },
    availabilityTtlMs: config.RUNTIME_AVAILABILITY_TTL_MS,
  };
}

function assertNever(value: never): never {
  throw new Error(`No execution provider is implemented for ${String(value)}`);
}
