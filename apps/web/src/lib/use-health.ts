import { useEffect, useState } from 'react';
import { healthResponseSchema, type HealthResponse } from '@platform/shared';
import { ApiError, apiRequest } from './api-client.js';

type State =
  | { status: 'loading' }
  | { status: 'ready'; data: HealthResponse }
  | { status: 'error'; message: string };

/**
 * Reads real readiness from the control plane. When the API is unreachable the
 * UI says so; it never renders a placeholder that implies health.
 */
export function useHealth(): State {
  const [state, setState] = useState<State>({ status: 'loading' });

  useEffect(() => {
    const controller = new AbortController();

    apiRequest<unknown>('/health/ready', { signal: controller.signal })
      .then((payload) => setState({ status: 'ready', data: healthResponseSchema.parse(payload) }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          status: 'error',
          message: error instanceof ApiError ? error.message : 'Unexpected client error',
        });
      });

    return () => controller.abort();
  }, []);

  return state;
}
