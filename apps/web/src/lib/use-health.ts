import { healthResponseSchema, type HealthResponse } from '@platform/shared';
import { apiRequest } from './api-client.js';
import { useResource, type Resource } from './use-resource.js';

export interface HealthReading {
  health: HealthResponse;
  /** When this reading arrived, for "Checked 2 min ago". */
  checkedAt: number;
}

/** How often the status page re-reads readiness while it is open. */
export const HEALTH_POLL_MS = 30_000;

/**
 * Reads real readiness from the control plane, and keeps reading while the
 * page is open. When the API is unreachable the UI says so; it never renders a
 * placeholder that implies health.
 */
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
