import type { ReactNode } from 'react';
import { useAction } from '../../lib/use-action.js';
import { useRuntime } from '../../workspace/use-runtime.js';
import { Button, ConfirmDialog, type ConfirmDialogProps } from '../../ui/index.js';
import { EnvironmentPill } from './EnvironmentPill.js';

export interface StopFirstDialogProps extends Omit<ConfirmDialogProps, 'body'> {
  projectId: string;
  /** The question's own sentence; the environment row is added below it. */
  body?: ReactNode;
}

/**
 * A confirm for an action the server refuses while the environment runs
 * (restoring a commit or a snapshot answers 409 then).
 *
 * The dialog shows the environment's state and offers the stop right there,
 * instead of sending the person back to the workspace to find out why the
 * restore was refused. The confirm itself stays enabled: the server is the
 * authority, and its refusal shows inside the dialog with a retry.
 */
export function StopFirstDialog({
  projectId,
  body,
  ...rest
}: StopFirstDialogProps): React.JSX.Element {
  const runtime = useRuntime(projectId);
  // use-runtime reports a failed stop through `runtime.error`; this only tracks busy.
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
