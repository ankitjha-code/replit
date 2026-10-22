import type { DeploymentSummary } from '@platform/shared';
import { ApiError } from '../../lib/api-client.js';
import { fetchDeploymentLog } from '../../lib/deployments-api.js';
import { useResource } from '../../lib/use-resource.js';
import { CodeBlock, Dialog } from '../../ui/index.js';
import { deploymentObjectName, deploymentTitle } from './deployment-words.js';

export function BuildLogDialog({
  projectId,
  deployment,
  onOpenChange,
}: {
  projectId: string;
  deployment: DeploymentSummary | undefined;
  onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  const deploymentId = deployment?.id;
  const log = useResource(
    async (signal) =>
      deploymentId ? fetchDeploymentLog(projectId, deploymentId, signal) : undefined,
    [projectId, deploymentId],
    { keepPrevious: false },
  );

  const error =
    log.status === 'error'
      ? log.error instanceof ApiError
        ? `Could not load this log. ${log.error.message}`
        : 'Could not load this log.'
      : undefined;

  return (
    <Dialog
      open={deployment !== undefined}
      onOpenChange={onOpenChange}
      size="lg"
      title={deployment ? `Build output for ${deploymentObjectName(deployment)}` : 'Build output'}
      description={deployment ? deploymentTitle(deployment) : undefined}
      loading={log.status === 'loading'}
      {...(error ? { error, onRetry: log.reload } : {})}
    >
      {log.data ? (
        log.data.log.length === 0 ? (
          <p className="ship-build__quiet">This build printed nothing.</p>
        ) : (
          <div className="ship-build">
            {log.data.truncated ? (
              <p className="ship-build__quiet">
                Only the end of this build&apos;s output was kept. A build fails at the end, so this
                is the part that says why.
              </p>
            ) : null}
            <CodeBlock code={log.data.log} label="Build log" copy />
          </div>
        )
      ) : null}
    </Dialog>
  );
}
