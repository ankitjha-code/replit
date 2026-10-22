import type { ReactNode } from 'react';
import { isRuntimeTransitional } from '@platform/shared';
import { ApiError } from '../../lib/api-client.js';
import { fetchRuntimeState, startRuntime, stopRuntime } from '../../lib/runtime-api.js';
import { useAction } from '../../lib/use-action.js';
import { useRuntime } from '../../workspace/use-runtime.js';
import { Button, Callout, toast } from '../../ui/index.js';

const SETTLE_ATTEMPTS = 60;
const SETTLE_INTERVAL_MS = 1_000;

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function restartEnvironment(projectId: string): Promise<void> {
  let state = await stopRuntime(projectId);
  for (let attempt = 0; attempt < SETTLE_ATTEMPTS; attempt += 1) {
    const status = state.runtime?.status;
    if (!status || !isRuntimeTransitional(status)) break;
    await wait(SETTLE_INTERVAL_MS);
    state = await fetchRuntimeState(projectId);
  }
  await startRuntime(projectId);
}

export function RestartCallout({
  projectId,
  children,
}: {
  projectId: string;
  children?: ReactNode;
}): React.JSX.Element {
  const runtime = useRuntime(projectId);
  const restart = useAction(async () => {
    await restartEnvironment(projectId);
    await runtime.refresh();
  });
  const running = runtime.state?.runtime?.status === 'RUNNING';

  const onRestart = async (): Promise<void> => {
    const outcome = await restart.run();
    if (outcome.ok) {
      toast({ tone: 'success', title: 'Environment restarting' });
    } else {
      toast({
        tone: 'danger',
        title: 'The environment could not be restarted',
        description:
          outcome.error instanceof ApiError
            ? outcome.error.message
            : 'Try again from the workspace.',
      });
    }
  };

  return (
    <Callout
      tone="info"
      action={
        running ? (
          <Button size="sm" loading={restart.busy} onClick={() => void onRestart()}>
            Restart environment
          </Button>
        ) : undefined
      }
    >
      {children ??
        (running
          ? 'Restart the environment for changes here to take effect.'
          : 'Changes here take effect the next time the environment starts.')}
    </Callout>
  );
}
