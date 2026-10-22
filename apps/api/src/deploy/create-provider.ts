import type { Logger } from 'pino';
import type { Env } from '../config/env.js';
import type { ExecutionProvider } from '../execution/provider.js';
import { ExecutionDeploymentProvider } from './execution-deployment-provider.js';
import type { DeploymentProvider } from './provider.js';
import { UnavailableDeploymentProvider } from './unavailable-provider.js';

/**
 * Chooses what builds and serves deployments.
 *
 * Named rather than inferred from whether an execution backend happens to be
 * configured. Deploying means serving somebody's code to the public, on an open
 * port, with no account required to reach it: an installation should have to
 * say it wants that rather than acquire it by having Docker running.
 *
 * `execution` builds in the same container plane that runs development
 * runtimes, which is the only one this platform has and the right one: a build
 * is a command run against a project's files, which is exactly what that plane
 * exists to do safely.
 */
export function createDeploymentProvider(
  config: Env,
  execution: ExecutionProvider,
  log: Logger,
): DeploymentProvider {
  switch (config.DEPLOYMENT_PROVIDER) {
    case 'execution':
      return new ExecutionDeploymentProvider(
        execution,
        {
          buildTimeoutMs: config.DEPLOYMENT_BUILD_TIMEOUT_MS,
          readyTimeoutMs: config.DEPLOYMENT_READY_TIMEOUT_MS,
          probeTimeoutMs: config.DEPLOYMENT_PROBE_TIMEOUT_MS,
          stopGraceSeconds: config.RUNTIME_STOP_GRACE_SECONDS,
        },
        log,
      );

    case 'none':
    default:
      return new UnavailableDeploymentProvider();
  }
}
