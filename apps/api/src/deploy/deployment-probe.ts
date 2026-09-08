import type { DependencyProbe } from '../modules/health/health.service.js';
import type { DeploymentProvider } from './provider.js';

/**
 * Health probe for the deployment backend.
 *
 * Registered only when one is configured. An installation deliberately running
 * without deployments is not unhealthy, and reporting it as down would make
 * readiness useless for the thing readiness is actually for: telling an
 * operator whether the platform can do what this installation asked it to do.
 *
 * The provider's own reason is reported, because it is already written to be
 * shown and carries no internal detail.
 */
export function deploymentProbe(provider: DeploymentProvider): DependencyProbe {
  return {
    name: `deployment:${provider.name}`,
    check: async () => {
      const reason = await provider.unavailableReason();
      return reason === null
        ? { status: 'up' as const, detail: 'able to build and serve' }
        : { status: 'down' as const, detail: reason };
    },
  };
}
