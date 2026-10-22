import type { Logger } from 'pino';
import type { Env } from '../config/env.js';
import { createDockerClient, DockerExecutionProvider } from './docker/docker-provider.js';
import type { DockerProviderOptions } from './docker/docker-provider.js';
import { parseExecutionHosts, type ExecutionHostConfig } from './hosts.js';
import type { ExecutionProvider } from './provider.js';
import { RoutingExecutionProvider } from './routing-provider.js';
import type { PlacementSource } from './scheduler.js';
import { UnavailableExecutionProvider } from './unavailable-provider.js';

export function createExecutionProvider(
  config: Env,
  log: Logger,
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
          defaultHost: hosts[0]!.name,
        },
        log,
      );
    }

    default:
      return assertNever(config.EXECUTION_PROVIDER);
  }
}

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

function dockerOptions(config: Env): DockerProviderOptions {
  return {
    networkPrefix: config.RUNTIME_NETWORK,
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
      applyExclusions: true,
    },
    collect: {
      maxFileBytes: config.DEPLOYMENT_MAX_FILE_BYTES,
      maxTotalBytes: config.DEPLOYMENT_MAX_ARTIFACT_BYTES,
      maxFiles: config.DEPLOYMENT_MAX_FILES,
      applyExclusions: false,
    },
    availabilityTtlMs: config.RUNTIME_AVAILABILITY_TTL_MS,
  };
}

function assertNever(value: never): never {
  throw new Error(`No execution provider is implemented for ${String(value)}`);
}
