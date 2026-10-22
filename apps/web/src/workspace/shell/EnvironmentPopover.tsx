import type { ReactElement } from 'react';
import { RUNTIME_DEFINITIONS, type RuntimeStateResponse } from '@platform/shared';
import { fetchRuntimeEvents } from '../../lib/runtime-events-api.js';
import { useResource } from '../../lib/use-resource.js';
import { Button, Callout, KeyValue, Popover, RelativeTime, Skeleton } from '../../ui/index.js';

const EVENT_ROWS = 10;

const STATUS_WORDS: Record<string, string> = {
  REQUESTED: 'Requested',
  CREATING: 'Creating',
  STARTING: 'Starting',
  RUNNING: 'Running',
  STOPPING: 'Stopping',
  STOPPED: 'Stopped',
  FAILED: 'Failed',
};

export interface EnvironmentPopoverProps {
  projectId: string | undefined;
  state: RuntimeStateResponse | undefined;
  trigger: ReactElement;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChangeLanguage?: () => void;
}

export function EnvironmentPopover({
  projectId,
  state,
  trigger,
  open,
  onOpenChange,
  onChangeLanguage,
}: EnvironmentPopoverProps): ReactElement {
  const runtime = state?.runtime ?? null;
  const detected = state?.detected ?? null;

  const items = [];
  if (runtime) {
    items.push({
      term: 'Language',
      value: `${RUNTIME_DEFINITIONS[runtime.language].displayName} ${runtime.version}`,
    });
    items.push({ term: 'Image', value: runtime.image, mono: true });
    if (runtime.startedAt) {
      items.push({ term: 'Started', value: <RelativeTime value={runtime.startedAt} /> });
    }
    items.push({
      term: 'Limits',
      value: `${runtime.limits.cpuMillicores / 1000} CPU, ${runtime.limits.memoryMb} MB, ${runtime.limits.pidsLimit} processes`,
    });
  } else if (detected) {
    items.push({
      term: 'Language',
      value: `${RUNTIME_DEFINITIONS[detected.language].displayName} ${detected.version}, from ${detected.evidence}`,
    });
    items.push({ term: 'Image', value: detected.image, mono: true });
  } else if (state) {
    items.push({ term: 'Language', value: 'Not detected yet' });
  }

  return (
    <Popover
      trigger={trigger}
      title="Environment details"
      open={open}
      onOpenChange={onOpenChange}
      align="start"
      className="env-popover"
    >
      {items.length ? <KeyValue items={items} /> : <Skeleton lines={3} />}
      {runtime?.message ? <p className="env-popover__message">{runtime.message}</p> : null}
      {!runtime && onChangeLanguage ? (
        <Button size="sm" onClick={onChangeLanguage} className="env-popover__change">
          Change language
        </Button>
      ) : null}
      {open && projectId ? <EventHistory projectId={projectId} /> : null}
    </Popover>
  );
}

function EventHistory({ projectId }: { projectId: string }): ReactElement {
  const events = useResource((signal) => fetchRuntimeEvents(projectId, signal), [projectId]);

  return (
    <section className="env-popover__history" aria-label="Recent history">
      <h3 className="env-popover__heading">Recent history</h3>
      {events.status === 'loading' ? (
        <Skeleton lines={3} />
      ) : events.status === 'error' ? (
        <Callout
          tone="danger"
          title="Could not read the history."
          action={
            <Button size="sm" onClick={events.reload}>
              Retry
            </Button>
          }
        />
      ) : events.data && events.data.length > 0 ? (
        <ol className="env-popover__events">
          {events.data.slice(0, EVENT_ROWS).map((event) => (
            <li key={event.id} className="env-popover__event">
              <span className="env-popover__event-word">{STATUS_WORDS[event.to] ?? event.to}</span>
              {event.reason ? (
                <span className="env-popover__event-reason">{event.reason}</span>
              ) : null}
              <RelativeTime value={event.at} className="env-popover__event-time" />
            </li>
          ))}
        </ol>
      ) : (
        <p className="env-popover__empty">Nothing has happened to this environment yet.</p>
      )}
    </section>
  );
}
