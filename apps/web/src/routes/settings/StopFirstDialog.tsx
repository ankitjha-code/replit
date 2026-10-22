import type { ReactNode } from 'react';
import { useAction } from '../../lib/use-action.js';
import { useRuntime } from '../../workspace/use-runtime.js';
import { Button, ConfirmDialog, type ConfirmDialogProps } from '../../ui/index.js';
import { EnvironmentPill } from './EnvironmentPill.js';

export interface StopFirstDialogProps extends Omit<ConfirmDialogProps, 'body'> {
  projectId: string;
  body?: ReactNode;
}

export function StopFirstDialog({
  projectId,
  body,
  ...rest
}: StopFirstDialogProps): React.JSX.Element {
  const runtime = useRuntime(projectId);
  const stop = useAction(() => runtime.stop());
  const status = runtime.state?.runtime?.status;
  const running = status === 'RUNNING' || status === 'STARTING';
  const stopping = stop.busy || status === 'STOPPING';

  return (
    <ConfirmDialog
      {...rest}
      body={
        <>
          {body}
          <div className="settings-environment">
            <EnvironmentPill state={runtime.state} loading={runtime.loading} />
            {running || stopping ? (
              <>
                <p className="settings-environment__text">The environment must be stopped first.</p>
                <Button
                  size="sm"
                  variant="secondary"
                  loading={stopping}
                  loadingLabel="Stopping the environment"
                  onClick={() => void stop.run()}
                >
                  Stop environment
                </Button>
              </>
            ) : null}
            {runtime.error ? (
              <p className="settings-environment__text" role="alert">
                {runtime.error}
              </p>
            ) : null}
          </div>
        </>
      }
    />
  );
}
