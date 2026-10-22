import { useState } from 'react';
import type { SweepReportView } from '@platform/shared';
import { ApiError } from '../../lib/api-client.js';
import { formatDuration } from '../../lib/format.js';
import { runSweep } from '../../lib/operations-api.js';
import { useAction } from '../../lib/use-action.js';
import { ArrowClockwise, Broom, Trash } from '../../ui/icons.js';
import {
  Button,
  Callout,
  Card,
  ConfirmDialog,
  EmptyState,
  KeyValue,
  RelativeTime,
  SectionHeader,
  toast,
  type KeyValueItem,
} from '../../ui/index.js';

type Step = SweepReportView['containers'];

const STEPS: ReadonlyArray<{
  key: 'containers' | 'networks' | 'databases' | 'objects';
  label: string;
}> = [
  { key: 'containers', label: 'Containers' },
  { key: 'networks', label: 'Networks' },
  { key: 'databases', label: 'Project databases' },
  { key: 'objects', label: 'Stored files' },
];

export function Cleanup(): React.JSX.Element {
  const [report, setReport] = useState<SweepReportView | undefined>();
  const [confirming, setConfirming] = useState(false);
  const dryRun = useAction(async () => {
    const result = await runSweep(true);
    setReport(result);
    return result;
  });

  const orphaned = report ? STEPS.reduce((sum, step) => sum + report[step.key].orphaned, 0) : 0;
  const errorMessage = dryRun.error
    ? dryRun.error instanceof ApiError
      ? dryRun.error.message
      : 'The sweep could not be run.'
    : undefined;

  return (
    <section className="operations-section" aria-labelledby="cleanup-heading">
      <SectionHeader
        id="cleanup-heading"
        title="Cleanup"
        description="Finds what the platform made and lost track of, and removes it only when you say so."
        help={
          <p>
            A dry run lists containers no record claims, networks whose project is gone, databases
            with no row, and stored files nothing references. Nothing newer than the grace period is
            touched, and expired sessions and preview links are removed on every run. The platform
            also runs this sweep on a schedule; running it here shows you what it finds.
          </p>
        }
      />

      {errorMessage ? (
        <Callout
          tone="danger"
          title={errorMessage}
          action={
            <Button size="sm" onClick={() => void dryRun.run()}>
              Retry
            </Button>
          }
        />
      ) : null}

      {report ? (
        <Card as="section" aria-labelledby="cleanup-report-heading" className="cleanup-report">
          <div className="cleanup-report__header">
            <div>
              <h3 id="cleanup-report-heading" className="cleanup-report__title">
                {report.dryRun ? 'Dry run' : 'Cleanup run'}
              </h3>
              <p className="cleanup-report__meta">
                <RelativeTime value={report.startedAt} prefix="Ran" />, took{' '}
                {formatDuration(
                  Math.max(
                    0,
                    Math.round(
                      (new Date(report.finishedAt).getTime() -
                        new Date(report.startedAt).getTime()) /
                        1000,
                    ),
                  ),
                )}
              </p>
            </div>
            <Button
              size="sm"
              icon={ArrowClockwise}
              loading={dryRun.busy}
              loadingLabel="Looking for orphans"
              onClick={() => void dryRun.run()}
            >
              Look again
            </Button>
          </div>

          <KeyValue items={describeReport(report)} className="cleanup-report__steps" />

          {report.dryRun && orphaned > 0 ? (
            <Callout
              tone="warn"
              title={`${orphaned} abandoned ${orphaned === 1 ? 'item' : 'items'} can be removed.`}
              action={
                <Button variant="danger" size="sm" icon={Trash} onClick={() => setConfirming(true)}>
                  Remove {orphaned} {orphaned === 1 ? 'item' : 'items'}
                </Button>
              }
            >
              Nothing is removed until you confirm.
            </Callout>
          ) : report.dryRun ? (
            <Callout tone="ok" title="Nothing to remove">
              Every container, network, database and stored file is accounted for.
            </Callout>
          ) : (
            <RemovalSummary report={report} />
          )}
        </Card>
      ) : (
        <EmptyState
          icon={Broom}
          title="No report yet."
          body="A dry run shows what the sweep would remove without removing anything."
          action={
            <Button
              variant="primary"
              icon={Broom}
              loading={dryRun.busy}
              loadingLabel="Looking for orphans"
              onClick={() => void dryRun.run()}
            >
              Look for orphans
            </Button>
          }
        />
      )}

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        tone="danger"
        title={`Remove ${orphaned} abandoned ${orphaned === 1 ? 'item' : 'items'}?`}
        body="Containers, networks, databases and stored files that no record claims are deleted. Nothing newer than the grace period is touched. This cannot be undone."
        confirmLabel={`Remove ${orphaned} ${orphaned === 1 ? 'item' : 'items'}`}
        onConfirm={async () => {
          const result = await runSweep(false);
          setReport(result);
          const removed = STEPS.reduce((sum, step) => sum + result[step.key].removed, 0);
          toast({
            tone: 'success',
            title: removed === 1 ? '1 item removed' : `${removed} items removed`,
          });
        }}
      />
    </section>
  );
}

function RemovalSummary({ report }: { report: SweepReportView }): React.JSX.Element {
  const removed = STEPS.reduce((sum, step) => sum + report[step.key].removed, 0);
  const failed = STEPS.reduce((sum, step) => sum + report[step.key].failed, 0);
  if (failed > 0) {
    return (
      <Callout tone="warn" title={`${removed} removed, ${failed} could not be removed.`}>
        Run the dry run again to see what is still there.
      </Callout>
    );
  }
  return (
    <Callout tone="ok" title={removed === 1 ? '1 item removed' : `${removed} items removed`} />
  );
}

export function describeStep(step: Step, dryRun: boolean): string {
  if (step.skipped) return `Not checked: ${step.skipped}`;
  const removed = dryRun ? 'nothing removed' : `${step.removed} removed`;
  const failed = step.failed > 0 ? `, ${step.failed} could not be removed` : '';
  return `${step.found} found, ${step.orphaned} abandoned, ${removed}${failed}`;
}

function describeReport(report: SweepReportView): KeyValueItem[] {
  return [
    ...STEPS.map((step) => ({
      term: step.label,
      value: describeStep(report[step.key], report.dryRun),
    })),
    {
      term: 'Expired sessions and links',
      value: `${report.sessions.removed} sessions, ${report.tokens.removed} links removed`,
    },
  ];
}
