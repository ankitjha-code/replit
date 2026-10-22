import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { AlertEvent, AlertKind, AlertResponse, AlertSettings } from '@platform/shared';
import { fetchAlerts, updateAlerts } from '../lib/alerts-api.js';
import { ApiError } from '../lib/api-client.js';
import { useAction } from '../lib/use-action.js';
import { useResource } from '../lib/use-resource.js';
import {
  Badge,
  Button,
  Callout,
  Checkbox,
  EmptyState,
  FormRow,
  Input,
  KeyValue,
  RelativeTime,
  SectionHeader,
  Skeleton,
  Table,
  toast,
} from '../ui/index.js';
import { Bell } from '../ui/icons.js';
import './observe/observe.css';

const KIND_LABELS: Record<AlertKind, string> = {
  HEALTH: 'Health check',
  MEMORY: 'Memory',
};

/** How many past alerts show before "Show more". */
const EVENTS_PAGE = 10;

/** The server's words for an owner whose address was never confirmed. */
const UNCONFIRMED_EMAIL = /confirmed their email/i;

/**
 * Being told when the deployment is in trouble.
 *
 * Shows, before anything else, whether an alert would actually reach anybody:
 * an alert that is recorded and never delivered is the failure people only
 * discover the morning after, and the page is the one place to say it first.
 */
export function ProjectAlerts({
  projectId,
  canEdit,
}: {
  projectId: string;
  canEdit: boolean;
}): React.JSX.Element {
  const resource = useResource((signal) => fetchAlerts(projectId, signal), [projectId]);
  // What the last save returned, until the next read replaces it.
  const [saved, setSaved] = useState<AlertResponse | undefined>();
  useEffect(() => setSaved(undefined), [resource.data]);
  const state = saved ?? resource.data;

  return (
    <section className="observe-section" aria-label="Alerts">
      <SectionHeader
        title="Alerts"
        icon={Bell}
        description="An email to the project owner when a deployment stops passing its health check or runs close to its memory limit, and another when it recovers."
      />

      {state === undefined && resource.status === 'loading' ? (
        <div className="observe-skeleton" aria-busy="true">
          <Skeleton width={160} />
          <Skeleton shape="row" />
          <Skeleton shape="row" />
        </div>
      ) : null}

      {resource.status === 'error' && state === undefined ? (
        <Callout
          tone="danger"
          title={
            resource.error instanceof ApiError
              ? resource.error.message
              : 'Alerts could not be loaded.'
          }
          action={
            <Button size="sm" onClick={resource.reload}>
              Retry
            </Button>
          }
        />
      ) : null}

      {state ? (
        <>
          {state.deliveryProblem ? <DeliveryProblem problem={state.deliveryProblem} /> : null}

          {state.firing.length > 0 ? (
            <Callout
              tone="danger"
              title={`Firing now: ${state.firing.map((kind) => KIND_LABELS[kind]).join(', ')}`}
              action={
                <Button size="sm" variant="link" asChild>
                  <a href="#monitoring-resources">See the readings</a>
                </Button>
              }
            />
          ) : null}

          {!state.settings.enabled && state.events.length === 0 ? (
            <EmptyState
              icon={Bell}
              title="Alerts are off."
              body="Get an email when the health check fails or memory runs out."
            />
          ) : null}

          {canEdit ? (
            <AlertsForm
              key={JSON.stringify(state.settings)}
              projectId={projectId}
              settings={state.settings}
              onSaved={setSaved}
            />
          ) : (
            <KeyValue
              items={[
                { term: 'Alerts', value: state.settings.enabled ? 'On' : 'Off' },
                {
                  term: 'Failed checks in a row before alerting',
                  value: String(state.settings.failuresBeforeAlert),
                },
                {
                  term: 'Memory alert',
                  value:
                    state.settings.memoryPercent === null
                      ? 'None'
                      : `At ${state.settings.memoryPercent}% of the limit`,
                },
              ]}
            />
          )}

          <p className="observe-note" aria-live="polite">
            {state.lastCheckedAt ? (
              <RelativeTime prefix="Last checked" value={state.lastCheckedAt} />
            ) : state.settings.enabled ? (
              'Not checked yet. Checks are made by the worker process.'
            ) : null}
          </p>

          {state.events.length > 0 ? <EventsTable events={state.events} /> : null}
        </>
      ) : null}
    </section>
  );
}

/**
 * Why an alert would go nowhere. Nothing is broken, so it is never red: an
 * unconfirmed address is fixed on the account page, and a missing mail server
 * is the installation's to fix.
 */
function DeliveryProblem({ problem }: { problem: string }): React.JSX.Element {
  if (UNCONFIRMED_EMAIL.test(problem)) {
    return (
      <Callout
        tone="info"
        title="Alerts are recorded here but not emailed yet"
        action={
          <Button size="sm" variant="link" asChild>
            <Link to="/account">Confirm your email on the account page</Link>
          </Button>
        }
      >
        {problem}
      </Callout>
    );
  }
  return (
    <Callout tone="warn" title="Alerts are recorded here but not emailed">
      {problem}
    </Callout>
  );
}

function AlertsForm({
  projectId,
  settings,
  onSaved,
}: {
  projectId: string;
  settings: AlertSettings;
  onSaved: (next: AlertResponse) => void;
}): React.JSX.Element {
  const [enabled, setEnabled] = useState(settings.enabled);
  const [failures, setFailures] = useState(String(settings.failuresBeforeAlert));
  const [memory, setMemory] = useState(
    settings.memoryPercent === null ? '' : String(settings.memoryPercent),
  );

  const draft: AlertSettings = {
    enabled,
    failuresBeforeAlert: Number(failures),
    memoryPercent: memory.trim() === '' ? null : Number(memory),
  };
  const dirty =
    draft.enabled !== settings.enabled ||
    draft.failuresBeforeAlert !== settings.failuresBeforeAlert ||
    draft.memoryPercent !== settings.memoryPercent;

  const save = useAction(() => updateAlerts(projectId, draft));

  const onSubmit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    const outcome = await save.run();
    if (outcome.ok) {
      onSaved(outcome.value);
      toast({
        tone: 'success',
        title: 'Alerts saved',
        description: 'Anything that was firing starts again from a clean slate.',
      });
    }
  };

  return (
    <form className="observe-form" onSubmit={(event) => void onSubmit(event)}>
      <Checkbox
        label="Alerts on"
        checked={enabled}
        onCheckedChange={(next) => {
          setEnabled(next);
          save.reset();
        }}
      />
      <FormRow
        label="Failed checks in a row before alerting"
        htmlFor="alert-failures"
        hint="1 to 20. More than one, so a single slow request is not an alert."
      >
        <Input
          id="alert-failures"
          type="number"
          inputMode="numeric"
          min={1}
          max={20}
          required
          value={failures}
          onChange={(event) => {
            setFailures(event.target.value);
            save.reset();
          }}
        />
      </FormRow>
      <FormRow
        label="Memory alert at % of the limit"
        htmlFor="alert-memory"
        hint="50 to 100. Blank leaves memory unwatched."
      >
        <Input
          id="alert-memory"
          type="number"
          inputMode="numeric"
          min={50}
          max={100}
          value={memory}
          onChange={(event) => {
            setMemory(event.target.value);
            save.reset();
          }}
        />
      </FormRow>
      {save.error ? (
        <Callout
          tone="danger"
          title={save.error instanceof ApiError ? save.error.message : 'Alerts could not be saved.'}
        />
      ) : null}
      <div className="observe-form__actions">
        <Button
          type="submit"
          variant="primary"
          loading={save.busy}
          loadingLabel="Saving"
          {...(dirty ? {} : { disabledReason: 'Nothing has changed yet' })}
        >
          Save alerts
        </Button>
      </div>
    </form>
  );
}

/** What fired, when, and whether anyone was told. Most recent first. */
function EventsTable({ events }: { events: AlertEvent[] }): React.JSX.Element {
  const [shown, setShown] = useState(EVENTS_PAGE);
  const rows = events.slice(0, shown);
  return (
    <div className="alerts-events">
      <h3 className="alerts-events__title">Recent alerts</h3>
      <Table
        caption="Recent alerts"
        density="dense"
        rows={rows}
        rowKey={(event) => event.id}
        empty={{ icon: Bell, title: 'No alerts yet.' }}
        columns={[
          {
            key: 'what',
            header: 'Alert',
            cell: (event) => (
              <span className="observe-row">
                {KIND_LABELS[event.kind]}
                <Badge tone={event.state === 'FIRING' ? 'danger' : 'ok'}>
                  {event.state === 'FIRING' ? 'alert' : 'cleared'}
                </Badge>
              </span>
            ),
          },
          {
            key: 'when',
            header: 'When',
            cell: (event) => <RelativeTime value={event.at} />,
          },
          {
            key: 'email',
            header: 'Email',
            cell: (event) => (event.notified ? 'emailed' : 'not emailed'),
          },
          { key: 'message', header: 'Detail', cell: (event) => event.message },
        ]}
        pagination={{
          count: rows.length,
          total: events.length,
          onMore: () => setShown((value) => value + EVENTS_PAGE),
        }}
      />
    </div>
  );
}
