import type { RunStatus } from '@platform/shared';
import { fetchRunState } from '../../lib/runtime-api.js';
import { useResource } from '../../lib/use-resource.js';

/**
 * Whether the project's application is running, as the frame needs to know
 * it: for the guide strip's stage, the phone switcher's dot and the "stop the
 * environment?" confirm. The console owns the full run state; this is one
 * read of the same endpoint, repeated only when the server says it changed.
 */
export function useAppRunning(
  projectId: string,
  environmentRunning: boolean,
  nonce: number,
): boolean {
  const run = useResource(
    async (signal) => {
      // Nothing can be running inside an environment that is not up, and the
      // server would say so with a blockedReason anyway.
      if (!environmentRunning) return 'IDLE' as RunStatus;
      return (await fetchRunState(projectId, signal)).status;
    },
    [projectId, environmentRunning, nonce],
  );
  return run.data === 'RUNNING' || run.data === 'STARTING';
}
