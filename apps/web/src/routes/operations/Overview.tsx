import type { OperationsOverview } from '@platform/shared';
import { ApiError } from '../../lib/api-client.js';
import { useResource } from '../../lib/use-resource.js';
import { ArrowClockwise } from '../../ui/icons.js';
import { Button, Callout, RelativeTime, SectionHeader, StatTile } from '../../ui/index.js';
import { fetchOverview } from '../../lib/operations-api.js';
import { operationsPath } from './pages.js';

/** How often the numbers are re-read while the page is open. */
export const OVERVIEW_POLL_MS = 30_000;

interface Reading {
  overview: OperationsOverview;
  at: number;
}

/**
 * The installation in four numbers.
 *
 * Failed work gets a tone of its own rather than being the third of three:
 * queued work that is not moving and failed work nobody saw are the two ways
 * a queue goes quietly wrong.
 */
export function Overview(): React.JSX.Element {
  const reading = useResource<Reading>(
    async (signal) => ({ overview: await fetchOverview(signal), at: Date.now() }),
    [],
    { poll: OVERVIEW_POLL_MS },
  );
  const overview = reading.data?.overview;
  const loading = reading.status === 'loading';
  const errorMessage =
    reading.status === 'error'
      ? reading.error instanceof ApiError
        ? reading.error.message
        : 'The overview could not be loaded.'
      : undefined;

  return (
    <section className="operations-section" aria-labelledby="overview-heading">
      <SectionHeader
        id="overview-heading"
        title="Overview"
        description="Accounts, projects and work on this installation right now."
        action={
          <div className="operations-overview__meta">
            {reading.data ? (
              <RelativeTime
                value={reading.data.at}
                prefix="Updated"
                className="operations-overview__updated"
              />
            ) : null}
            <Button
              size="sm"
              icon={ArrowClockwise}
              loading={reading.status === 'refreshing'}
              loadingLabel="Refreshing"
              onClick={reading.reload}
            >
              Refresh
            </Button>
          </div>
        }
      />

      {errorMessage && !overview ? (
        <Callout
          tone="danger"
          title={errorMessage}
          action={
            <Button size="sm" onClick={reading.reload}>
              Retry
            </Button>
          }
        />
      ) : (
        <>
          {errorMessage ? (
            <Callout
              tone="warn"
              title="Could not refresh. These numbers are from the last successful read."
              action={
                <Button size="sm" onClick={reading.reload}>
                  Retry
                </Button>
              }
            />
          ) : null}
          <div className="operations-tiles" aria-busy={loading || undefined}>
            <StatTile
              label="Accounts"
              to={operationsPath('accounts')}
              loading={loading}
              value={overview?.accounts.total}
              detail={
                overview
                  ? `${overview.accounts.verified} confirmed, ${overview.accounts.operators} operators`
                  : ' '
              }
            />
            <StatTile
              label="Projects"
              loading={loading}
              value={overview?.projects.total}
              detail={
                overview
                  ? `${overview.deployments.live} live, ${overview.deployments.failed} failed deployments`
                  : ' '
              }
            />
            <StatTile
              label="Environments running"
              to={operationsPath('hosts')}
              loading={loading}
              value={overview?.projects.running}
              detail={overview ? `of ${overview.projects.total} projects` : ' '}
            />
            <StatTile
              label="Activity queued"
              loading={loading}
              tone={overview && overview.jobs.failed > 0 ? 'warn' : 'neutral'}
              value={overview?.jobs.queued}
              detail={
                overview ? `${overview.jobs.running} running, ${overview.jobs.failed} failed` : ' '
              }
            />
          </div>
        </>
      )}
    </section>
  );
}
