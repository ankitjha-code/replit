import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Link } from 'react-router-dom';
import {
  usageFraction,
  type ApplicationHealth,
  type MonitoringResponse,
  type WatchedWorkload,
  type WorkloadUsage,
} from '@platform/shared';
import { ApiError } from '../lib/api-client.js';
import { fieldErrorsFrom } from '../lib/form-errors.js';
import { formatBytes } from '../lib/format.js';
import { fetchMonitoring, setHealthCheck } from '../lib/monitoring-api.js';
import { useAction } from '../lib/use-action.js';
import { useResource } from '../lib/use-resource.js';
import {
  Badge,
  Button,
  Callout,
  EmptyState,
  FormRow,
  Input,
  Meter,
  RelativeTime,
  SectionHeader,
  Skeleton,
  Spinner,
  StatTile,
  Switch,
  toast,
} from '../ui/index.js';
import { ArrowsClockwise, Pulse } from '../ui/icons.js';
import './observe/observe.css';

/**
 * What this project is using, and whether it is answering.
 *
 * It shows measurements and nothing else: every number here came back from a
 * container runtime or from an HTTP request that actually happened, and
 * anything that could not be measured says "not measured" rather than showing
 * a zero. A bar at zero and a bar that could not be drawn look the same on a
 * chart and mean opposite things, so the second one is not drawn at all.
 */
export function ProjectMonitoring({
  projectId,
  canControl,
}: {
  projectId: string;
  canControl: boolean;
}): React.JSX.Element {
  /*
   * Polling, on while the page is open and looked at.
   *
   * Every reading costs a round trip to a container runtime, so the poll stops
   * while the tab is hidden: a page left open on a forgotten tab would
   * otherwise measure a project for ever. The switch turns it off for someone
   * who wants a still snapshot; "Check now" is always there for one reading.
   */
  const [live, setLive] = useState(true);
  const visible = useDocumentVisible();
  const polling = live && visible;
  const [readAt, setReadAt] = useState<number | undefined>();

  const resource = useResource(
    async (signal) => {
      const fetched = await fetchMonitoring(projectId, signal);
      setReadAt(Date.now());
      return fetched;
    },
    [projectId, polling],
    { poll: (data) => (polling ? Math.max(data.sampleIntervalSeconds, 1) * 1000 : null) },
  );
  const state = resource.data;
  const checking = resource.status === 'loading' || resource.status === 'refreshing';

  const measuring = state !== undefined && state.workloads.length > 0;

  return (
    <section className="observe-section" aria-label="Resources">
      <SectionHeader
        title="Resources"
        icon={Pulse}
        description="What the environment and deployments are using right now, and whether the app answers."
        help={
          state !== undefined ? (
            <p>
              Readings are taken when asked for. The trend covers about{' '}
              {Math.round(state.historySeconds / 60)} minutes and is held in memory: it starts when
              this page is first read and is gone when the platform restarts. The health check asks
              for the path below and treats any answer under 400 as healthy.
            </p>
          ) : undefined
        }
        action={
          <Button
            size="sm"
            icon={ArrowsClockwise}
            loading={checking}
            loadingLabel="Checking"
            onClick={resource.reload}
          >
            Check now
          </Button>
        }
      />

      {state === undefined && resource.status === 'loading' ? (
        <div className="observe-skeleton" aria-busy="true">
          <Skeleton width={240} />
          <div className="monitoring-tiles">
            <StatTile label="Processor" loading detail="of the limit" />
            <StatTile label="Memory" loading detail="of the limit" />
            <StatTile label="Processes" loading detail="of the limit" />
          </div>
        </div>
      ) : null}

      {resource.status === 'error' ? (
        <Callout
          tone="danger"
          title={
            resource.error instanceof ApiError
              ? resource.error.message
              : 'Monitoring could not be loaded.'
          }
          action={
            <Button size="sm" onClick={resource.reload}>
              Retry
            </Button>
          }
        />
      ) : null}

      {state?.unavailableReason ? <Callout tone="info">{state.unavailableReason}</Callout> : null}

      {state && !state.unavailableReason && state.workloads.length === 0 ? (
        <EmptyState
          icon={Pulse}
          title="Nothing to measure."
          body="Readings appear while the environment or a deployment is running."
          action={
            <Button variant="primary" asChild>
              <Link to={`/projects/${encodeURIComponent(projectId)}`}>Open workspace</Link>
            </Button>
          }
        />
      ) : null}

      {state && measuring ? (
        <>
          <div className="observe-row">
            <Switch
              size="sm"
              label={`Keep measuring every ${state.sampleIntervalSeconds}s`}
              checked={live}
              onCheckedChange={setLive}
            />
            {readAt !== undefined ? (
              <span className="observe-note" aria-live="polite">
                <RelativeTime prefix="Read" value={readAt} />
              </span>
            ) : null}
          </div>

          {state.workloads.map((workload) => (
            <Workload key={workload.id} workload={workload} historySeconds={state.historySeconds} />
          ))}
        </>
      ) : null}

      {canControl && state && measuring ? (
        <HealthCheckForm
          projectId={projectId}
          config={state.healthCheck}
          onSaved={resource.reload}
        />
      ) : null}
    </section>
  );
}

/** One container: what it is using, and whether what is in it answers. */
function Workload({
  workload,
  historySeconds,
}: {
  workload: WatchedWorkload;
  historySeconds: number;
}): React.JSX.Element {
  const usage = workload.usage;
  return (
    <article className="monitoring-workload" aria-label={workloadName(workload)}>
      <header className="monitoring-workload__head">
        <span className="monitoring-workload__name">
          {workload.kind === 'RUNTIME' ? 'Environment' : 'Deployment'}
          <span className="monitoring-workload__label">{workload.label}</span>
        </span>
        <span aria-live="polite">
          <HealthBadge health={workload.health} />
        </span>
        {usage ? (
          <span className="monitoring-workload__read">
            <RelativeTime prefix="Measured" value={usage.at} />
          </span>
        ) : null}
      </header>

      {workload.health.message ? <p className="observe-note">{workload.health.message}</p> : null}

      {usage ? (
        <>
          <div className="monitoring-tiles">
            <UsageTile
              label="Processor"
              value={usage.cpuMillicores}
              limit={usage.cpuLimitMillicores}
              format={(value) => `${value} of ${usage.cpuLimitMillicores} millicores`}
            />
            <UsageTile
              label="Memory"
              value={usage.memoryBytes}
              limit={usage.memoryLimitBytes}
              format={(value) => `${formatBytes(value)} of ${formatBytes(usage.memoryLimitBytes)}`}
            />
            <UsageTile
              label="Processes"
              value={usage.pids}
              limit={usage.pidsLimit}
              format={(value) => `${value} of ${usage.pidsLimit}`}
            />
          </div>
          <Sparkline history={workload.history} historySeconds={historySeconds} />
        </>
      ) : (
        <p className="observe-note">
          {workload.kind === 'DEPLOYMENT'
            ? 'Served by the platform, so there is no container to measure.'
            : 'Nothing could be measured for this container.'}
        </p>
      )}
    </article>
  );
}

const subscribeVisibility = (onChange: () => void): (() => void) => {
  document.addEventListener('visibilitychange', onChange);
  return () => document.removeEventListener('visibilitychange', onChange);
};

/** Whether this tab is the one on screen. Polling is paused while it is not. */
function useDocumentVisible(): boolean {
  return useSyncExternalStore(
    subscribeVisibility,
    () => document.visibilityState !== 'hidden',
    () => true,
  );
}

function workloadName(workload: WatchedWorkload): string {
  return `${workload.kind === 'RUNTIME' ? 'Environment' : 'Deployment'} ${workload.label}`;
}

/** A share of the limit as the headline, the measurement itself as the bar. */
function UsageTile({
  label,
  value,
  limit,
  format,
}: {
  label: string;
  value: number | null;
  limit: number;
  format: (value: number) => string;
}): React.JSX.Element {
  const fraction = usageFraction(value, limit);
  if (fraction === null || value === null) {
    return (
      <StatTile label={label} value={<span className="monitoring-tile__none">Not measured</span>} />
    );
  }
  const tone = fraction >= 0.95 ? 'danger' : fraction >= 0.8 ? 'warn' : 'neutral';
  return (
    <StatTile
      label={label}
      tone={tone}
      value={`${Math.round(fraction * 100)}%`}
      detail={<Meter label={label} value={value} max={limit} format={format} />}
    />
  );
}

/** Whether the application answered, in the words the page uses. */
function HealthBadge({ health }: { health: ApplicationHealth }): React.JSX.Element {
  switch (health.state) {
    case 'healthy':
      return (
        <Badge tone="ok">
          {health.latencyMs === null ? 'Answering' : `Answering in ${health.latencyMs}ms`}
        </Badge>
      );
    case 'unhealthy':
      return <Badge tone="warn">Answered with {String(health.statusCode)}</Badge>;
    case 'unreachable':
      return <Badge tone="danger">Not answering</Badge>;
    case 'unknown':
      return <Badge tone="neutral">Not checked</Badge>;
  }
}

const SPARKLINE_WIDTH = 240;
const SPARKLINE_HEIGHT = 48;

/**
 * Recent processor readings as one line.
 *
 * Deliberately tiny and deliberately not a charting library. What somebody
 * needs from a trend on this page is whether the line is going up, and a
 * hundred kilobytes of chart code would answer that no better than this does.
 * It draws from the first reading: a single dot with "Collecting" is more
 * honest than an empty box.
 */
function Sparkline({
  history,
  historySeconds,
}: {
  history: WorkloadUsage[];
  historySeconds: number;
}): React.JSX.Element {
  const [hover, setHover] = useState<number | undefined>();
  const readings = history.filter(
    (sample): sample is WorkloadUsage & { cpuMillicores: number } => sample.cpuMillicores !== null,
  );
  const latest = readings.at(-1);
  const minutes = Math.max(1, Math.round(historySeconds / 60));

  const points = readings.map((sample, index) => {
    const fraction = usageFraction(sample.cpuMillicores, sample.cpuLimitMillicores) ?? 0;
    const x =
      readings.length === 1
        ? SPARKLINE_WIDTH / 2
        : (index / (readings.length - 1)) * SPARKLINE_WIDTH;
    // Two pixels of headroom so a reading at the limit still shows its stroke.
    const y = 2 + (1 - fraction) * (SPARKLINE_HEIGHT - 4);
    return { x, y, sample };
  });

  const onMove = (event: React.MouseEvent<HTMLDivElement>): void => {
    if (points.length < 2) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const share = (event.clientX - rect.left) / Math.max(rect.width, 1);
    setHover(Math.min(points.length - 1, Math.max(0, Math.round(share * (points.length - 1)))));
  };

  const hovered = hover === undefined ? undefined : points[hover];

  return (
    <figure className="sparkline" aria-label={`Processor use over the last ${minutes} minutes`}>
      <figcaption className="sparkline__head">
        <span>
          {readings.length < 2
            ? 'Processor, collecting readings…'
            : `Processor, last ${minutes} min (${readings.length} readings)`}
        </span>
        {latest ? (
          <span className="sparkline__value">{latest.cpuMillicores} millicores now</span>
        ) : null}
      </figcaption>
      <div
        className="sparkline__plot"
        onMouseMove={onMove}
        onMouseLeave={() => setHover(undefined)}
      >
        {points.length === 0 ? (
          <span className="sparkline__collecting">
            <Spinner size={12} aria-hidden="true" /> Collecting…
          </span>
        ) : (
          <svg
            className="sparkline__svg"
            viewBox={`0 0 ${SPARKLINE_WIDTH} ${SPARKLINE_HEIGHT}`}
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            {points.length > 1 ? (
              <>
                <polygon
                  className="sparkline__area"
                  points={`0,${SPARKLINE_HEIGHT} ${points.map((p) => `${p.x},${p.y}`).join(' ')} ${SPARKLINE_WIDTH},${SPARKLINE_HEIGHT}`}
                />
                <polyline
                  className="sparkline__line"
                  points={points.map((p) => `${p.x},${p.y}`).join(' ')}
                />
              </>
            ) : null}
            {hovered ? (
              <line
                className="sparkline__cursor"
                x1={hovered.x}
                x2={hovered.x}
                y1={0}
                y2={SPARKLINE_HEIGHT}
              />
            ) : null}
            {points.length === 1 || hovered ? (
              <circle
                className="sparkline__dot"
                cx={(hovered ?? points[0]!).x}
                cy={(hovered ?? points[0]!).y}
                r={4}
              />
            ) : null}
          </svg>
        )}
        {hovered ? (
          <span
            className="sparkline__tip"
            style={{ left: `${(hovered.x / SPARKLINE_WIDTH) * 100}%` }}
            role="status"
          >
            {hovered.sample.cpuMillicores} millicores at{' '}
            {new Date(hovered.sample.at).toLocaleTimeString()}
          </span>
        ) : null}
      </div>
    </figure>
  );
}

/**
 * How the application is checked: the path asked for and how long an answer
 * is waited for. Shown only while something runs, because the answer to
 * "is it healthy" needs something to ask.
 */
function HealthCheckForm({
  projectId,
  config,
  onSaved,
}: {
  projectId: string;
  config: MonitoringResponse['healthCheck'];
  onSaved: () => void;
}): React.JSX.Element {
  const [path, setPath] = useState(config.path);
  const [timeout, setTimeoutText] = useState(String(config.timeoutMs));
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<string, string>>>({});
  const [message, setMessage] = useState<string | undefined>();

  // A fresh reading may carry a path saved elsewhere; adopt it unless the
  // person is mid-edit.
  const lastConfig = useRef(config);
  useEffect(() => {
    if (lastConfig.current === config) return;
    lastConfig.current = config;
    setPath(config.path);
    setTimeoutText(String(config.timeoutMs));
  }, [config]);

  const dirty = path !== config.path || timeout !== String(config.timeoutMs);

  const save = useAction(async () => {
    const timeoutMs = Number(timeout);
    await setHealthCheck(projectId, {
      path,
      ...(Number.isFinite(timeoutMs) && timeout.trim() !== '' ? { timeoutMs } : {}),
    });
  });

  const onSubmit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setFieldErrors({});
    setMessage(undefined);
    const outcome = await save.run();
    if (outcome.ok) {
      toast({ tone: 'success', title: 'Health check saved' });
      onSaved();
      return;
    }
    const parsed = fieldErrorsFrom(outcome.error);
    setFieldErrors(parsed.fields);
    if (Object.keys(parsed.fields).length === 0) {
      setMessage(parsed.message ?? 'That check could not be saved.');
    }
  };

  return (
    <form className="observe-form" onSubmit={(event) => void onSubmit(event)}>
      <FormRow
        label="Health check path"
        htmlFor="health-path"
        hint="Any answer under 400 counts as healthy."
      >
        <Input
          id="health-path"
          mono
          value={path}
          onChange={(event) => setPath(event.target.value)}
          placeholder="/"
          autoComplete="off"
          required
          invalid={Boolean(fieldErrors.path)}
          aria-describedby={fieldErrors.path ? 'health-path-error' : undefined}
        />
        {fieldErrors.path ? (
          <p id="health-path-error" className="observe-field-error" role="alert">
            {fieldErrors.path}
          </p>
        ) : null}
      </FormRow>
      <FormRow
        label="Timeout"
        htmlFor="health-timeout"
        hint="Milliseconds to wait for an answer, 100 to 30000."
      >
        <Input
          id="health-timeout"
          type="number"
          inputMode="numeric"
          min={100}
          max={30_000}
          step={100}
          value={timeout}
          onChange={(event) => setTimeoutText(event.target.value)}
          required
          invalid={Boolean(fieldErrors.timeoutMs)}
          aria-describedby={fieldErrors.timeoutMs ? 'health-timeout-error' : undefined}
        />
        {fieldErrors.timeoutMs ? (
          <p id="health-timeout-error" className="observe-field-error" role="alert">
            {fieldErrors.timeoutMs}
          </p>
        ) : null}
      </FormRow>
      {message ? <Callout tone="danger" title={message} /> : null}
      <div className="observe-form__actions">
        <Button
          type="submit"
          variant="primary"
          loading={save.busy}
          loadingLabel="Saving"
          {...(dirty ? {} : { disabledReason: 'Nothing has changed yet' })}
        >
          Save check
        </Button>
      </div>
    </form>
  );
}
