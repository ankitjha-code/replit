import { healthResponseSchema, type HealthResponse } from '@platform/shared';
import { apiRequest } from './api-client.js';
import { useResource, type Resource } from './use-resource.js';

export interface HealthReading {
  health: HealthResponse;
  checkedAt: number;
}

export const HEALTH_POLL_MS = 30_000;

export function useHealth(): Resource<HealthReading> {
  return useResource(
    async (signal) => {
      const payload = await apiRequest<unknown>('/health/ready', { signal });
      return { health: healthResponseSchema.parse(payload), checkedAt: Date.now() };
    },
    [],
    { poll: HEALTH_POLL_MS },
  );
}
