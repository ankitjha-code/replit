import type { DependencyProbe } from '../modules/health/health.service.js';
import type { DeploymentProvider } from './provider.js';

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
