import type { Logger } from 'pino';
import type { Env } from '../config/env.js';
import type { ExecutionProvider } from '../execution/provider.js';
import { ExecutionDeploymentProvider } from './execution-deployment-provider.js';
import type { DeploymentProvider } from './provider.js';
import { UnavailableDeploymentProvider } from './unavailable-provider.js';

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
