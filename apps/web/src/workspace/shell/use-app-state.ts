import type { RunStatus } from '@platform/shared';
import { fetchRunState } from '../../lib/runtime-api.js';
import { useResource } from '../../lib/use-resource.js';

export function useAppRunning(
  projectId: string,
  environmentRunning: boolean,
  nonce: number,
): boolean {
  const run = useResource(
    async (signal) => {
      if (!environmentRunning) return 'IDLE' as RunStatus;
      return (await fetchRunState(projectId, signal)).status;
    },
    [projectId, environmentRunning, nonce],
  );
  return run.data === 'RUNNING' || run.data === 'STARTING';
}
