import type { ReactElement } from 'react';
import { Link } from 'react-router-dom';
import type { DependencyHealth, HealthResponse } from '@platform/shared';
import { useAuth } from '../lib/auth-context.js';
import { formatDuration } from '../lib/format.js';
import { useDocumentTitle } from '../lib/use-document-title.js';
import { useHealth } from '../lib/use-health.js';
import { NotFoundPage } from './NotFoundPage.js';
import {
  Badge,
  Button,
  Callout,
  KeyValue,
  PageHeader,
  RelativeTime,
  SectionHeader,
  Spinner,
  Table,
  type TableColumn,
} from '../ui/index.js';
import { ArrowClockwise, CheckCircle, Circle, PlugsConnected, XCircle } from '../ui/icons.js';

const OVERALL: Record<HealthResponse['status'], { tone: 'ok' | 'warn' | 'danger'; word: string }> =
  {
    ok: { tone: 'ok', word: 'All systems up' },
    degraded: { tone: 'warn', word: 'Degraded' },
    down: { tone: 'danger', word: 'Down' },
  };

function DependencyStatus({ status }: { status: DependencyHealth['status'] }): ReactElement {
  if (status === 'up') {
    return (
      <Badge tone="ok" icon={CheckCircle}>
        Up
      </Badge>
    );
  }
  if (status === 'down') {
    return (
      <Badge tone="danger" icon={XCircle}>
        Down
      </Badge>
    );
  }
  return (
    <Badge tone="warn" icon={Circle}>
      Unknown
    </Badge>
  );
}

const COLUMNS: TableColumn<DependencyHealth>[] = [
  { key: 'name', header: 'Dependency', cell: (dep) => <span>{dep.name}</span> },
  {
    key: 'status',
    header: 'Status',
    width: '120px',
    cell: (dep) => <DependencyStatus status={dep.status} />,
  },
  {
    key: 'latency',
    header: 'Response time',
    width: '140px',
    align: 'end',
    mono: true,
    cell: (dep) => (dep.latencyMs === undefined ? '' : `${dep.latencyMs} ms`),
  },
  { key: 'detail', header: 'Detail', cell: (dep) => dep.detail ?? '' },
];

export function SystemStatusPage(): ReactElement {
  const { user } = useAuth();
  if (user?.isOperator !== true) return <NotFoundPage />;
  return <StatusReport />;
}

function StatusReport(): ReactElement {
  useDocumentTitle(['System status']);
  const reading = useHealth();
  const health = reading.data?.health;
  const loading = reading.status === 'loading';
  const plainHttp = typeof window !== 'undefined' && window.location.protocol === 'http:';

  return (
    <div className="page status-page">
      <PageHeader
        title="System status"
        description="Whether the platform and the services it depends on are answering right now."
        status={
          health ? (
            <Badge tone={OVERALL[health.status].tone} dot={health.status === 'ok'}>
              {OVERALL[health.status].word}
            </Badge>
          ) : undefined
        }
        secondaryActions={[
          {
            label: 'Refresh',
            icon: ArrowClockwise,
            onSelect: reading.reload,
            ...(reading.status === 'refreshing' ? { disabledReason: 'Checking now' } : {}),
          },
        ]}
      />

      {reading.status === 'error' ? (
        <Callout
          tone="danger"
          title={reading.error?.message ?? 'Could not read the status'}
          action={
            <Button size="md" onClick={reading.reload}>
              Retry
            </Button>
          }
        >
          The status could not be read. The platform may still be running.
        </Callout>
      ) : (
        <>
          <section className="status-page__section" aria-labelledby="status-service">
            <SectionHeader id="status-service" title="Service" />
            <KeyValue
              loading={loading}
              items={
                health
                  ? [
                      { term: 'Service', value: health.service, mono: true },
                      { term: 'Version', value: health.version, mono: true },
                      { term: 'Up for', value: formatDuration(health.uptimeSeconds) },
                    ]
                  : []
              }
            />
            <p className="status-page__checked" aria-live="polite">
              {reading.status === 'refreshing' ? (
                <Spinner size={12} label="Checking" labelVisible />
              ) : reading.data ? (
                <RelativeTime value={reading.data.checkedAt} prefix="Checked" />
              ) : null}
            </p>
          </section>

          <section className="status-page__section" aria-labelledby="status-dependencies">
            <SectionHeader
              id="status-dependencies"
              title="Dependencies"
              description="What the API needs to serve traffic, and whether each answered its last probe."
            />
            <Table
              caption="Dependencies the API relies on"
              columns={COLUMNS}
              rows={health?.dependencies ?? []}
              rowKey={(dep) => dep.name}
              loading={loading}
              density="dense"
              empty={{
                icon: PlugsConnected,
                title: 'No dependencies registered yet.',
                body: 'Dependencies appear here as the installation gains them.',
              }}
            />
          </section>

          <section className="status-page__section" aria-labelledby="status-operators">
            <SectionHeader
              id="status-operators"
              title="For operators"
              action={
                <Button variant="link" asChild>
                  <Link to="/operations">Operations</Link>
                </Button>
              }
            />
            {plainHttp ? (
              <Callout tone="info" title="Previews open in a new tab on this installation">
                It is served over HTTP, so the workspace cannot frame a preview. Set
                PREVIEW_SCHEME=https to show previews inside the workspace.
              </Callout>
            ) : (
              <p className="status-page__note">Previews are framed inside the workspace.</p>
            )}
          </section>
        </>
      )}
    </div>
  );
}
