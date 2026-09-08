import { useCallback, useEffect, useRef, useState } from 'react';
import {
  usageFraction,
  type ApplicationHealth,
  type MonitoringResponse,
  type WatchedWorkload,
  type WorkloadUsage,
} from '@platform/shared';
import { ApiError } from '../lib/api-client.js';
import { fieldErrorsFrom } from '../lib/form-errors.js';
import { fetchMonitoring, setHealthCheck } from '../lib/monitoring-api.js';

/**
 * What this project is using, and whether it is answering.
 *
 * The page the previous two tasks were for. It shows measurements and nothing
 * else: every number here came back from a container runtime or from an HTTP
 * request that actually happened, and anything that could not be measured says
 * "not measured" rather than showing a zero.
 *
 * That rule is why the bars can be empty. A bar at zero and a bar that could not
 * be drawn look the same on a chart and mean opposite things, so the second one
 * is not drawn at all.
 */
export function ProjectMonitoring({
  projectId,
  canControl,
}: {
  projectId: string;
  canControl: boolean;
}): React.JSX.Element {
  const [state, setState] = useState<MonitoringResponse | undefined>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [path, setPath] = useState('');
  const [live, setLive] = useState(false);

  /** Held in a ref so the polling effect does not restart on every answer. */
  const interval = useRef(5);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const fetched = await fetchMonitoring(projectId, signal);
        if (signal?.aborted) return;

        setState(fetched);
        interval.current = fetched.sampleIntervalSeconds;
        setError(undefined);
      } catch (cause) {
        if (signal?.aborted) return;
        setError(cause instanceof ApiError ? cause.message : 'Monitoring could not be loaded.');
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [projectId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  /*
   * Polling, off by default and asked for.
   *
   * Every reading costs a round trip to a container runtime, so a page left
   * open on a forgotten tab would measure a project for ever. Somebody watching
   * something happen turns it on; the rest of the time this is a snapshot with
   * a refresh button.
   */
  useEffect(() => {
    if (!live) return;

    const timer = setInterval(() => void load(), Math.max(interval.current, 1) * 1000);
    return () => clearInterval(timer);
  }, [live, load]);

  useEffect(() => {
    if (state?.healthCheck.path) setPath(state.healthCheck.path);
  }, [state?.healthCheck.path]);

  const saveCheck = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);

    try {
      await setHealthCheck(projectId, { path });
      await load();
    } catch (cause) {
      const { fields, message } = fieldErrorsFrom(cause);
      setError(
        fields.path ??
          message ??
          (cause instanceof ApiError ? cause.message : 'That check could not be saved.'),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="project-section" aria-labelledby="monitoring-heading">
      <h2 id="monitoring-heading">Resources and health</h2>
      <p className="project-section__hint">
        What this project&apos;s containers are using, measured now, and whether the application in
        them answers. Anything the platform could not measure says so rather than showing a zero.
      </p>

      {state?.unavailableReason && (
        <p className="project-section__error" role="status">
          {state.unavailableReason}
        </p>
      )}

      {error && (
        <p className="project-section__error" role="alert">
          {error}
        </p>
      )}

      {loading && <p className="project-section__note">Taking a reading…</p>}

      {!loading && state && state.workloads.length === 0 && !state.unavailableReason && (
        <p className="project-section__note">
          Nothing is running, so there is nothing to measure. Start the project or deploy it.
        </p>
      )}

      {state && state.workloads.length > 0 && (
        <>
          <div className="project-section__actions">
            <button
              type="button"
              className="icon-button"
              disabled={busy}
              onClick={() => void load()}
            >
              Take a reading
            </button>
            <label className="monitoring__live">
              <input
                type="checkbox"
                checked={live}
                onChange={(event) => setLive(event.target.checked)}
              />{' '}
              Keep measuring every {state.sampleIntervalSeconds}s
            </label>
          </div>

          <ul className="project-section__list">
            {state.workloads.map((workload) => (
              <Workload key={workload.id} workload={workload} />
            ))}
          </ul>

          {/* Said plainly, because a trend that resets is worse than no trend
              if somebody thinks it is a record. */}
          <p className="project-section__note">
            The trend covers about {Math.round(state.historySeconds / 60)} minutes and is held in
            memory: it starts when you open this page and is gone when the platform restarts.
          </p>
        </>
      )}

      {canControl && (
        <form className="project-section__form" onSubmit={(event) => void saveCheck(event)}>
          <label htmlFor="health-path">Health check path</label>
          <input
            id="health-path"
            value={path}
            onChange={(event) => setPath(event.target.value)}
            placeholder="/"
            autoComplete="off"
            required
          />
          <button type="submit" className="button-quiet" disabled={busy}>
            {busy ? 'Saving…' : 'Save check'}
          </button>
        </form>
      )}

      {canControl && (
        <p className="project-section__note">
          The platform asks for this path and treats any answer below 400 as healthy. Change it if
          your application serves nothing at its root.
        </p>
      )}
    </section>
  );
}

/** One container: what it is using, and whether what is in it answers. */
function Workload({ workload }: { workload: WatchedWorkload }): React.JSX.Element {
  return (
    <li className="project-section__item">
      <span className="project-section__item-name">
        {workload.kind === 'RUNTIME' ? 'Workspace' : 'Deployment'} — {workload.label}
      </span>

      <Health health={workload.health} />

      {workload.usage ? (
        <>
          <Meter
            label="Processor"
            value={workload.usage.cpuMillicores}
            limit={workload.usage.cpuLimitMillicores}
            format={(value) => `${value} of ${workload.usage?.cpuLimitMillicores ?? 0} millicores`}
          />
          <Meter
            label="Memory"
            value={workload.usage.memoryBytes}
            limit={workload.usage.memoryLimitBytes}
            format={(value) =>
              `${formatBytes(value)} of ${formatBytes(workload.usage?.memoryLimitBytes ?? 0)}`
            }
          />
          <Meter
            label="Processes"
            value={workload.usage.pids}
            limit={workload.usage.pidsLimit}
            format={(value) => `${value} of ${workload.usage?.pidsLimit ?? 0}`}
          />
          <Trend history={workload.history} />
        </>
      ) : (
        <span className="project-section__item-meta">
          {workload.kind === 'DEPLOYMENT'
            ? 'Served by the platform, so there is no container to measure.'
            : 'Nothing could be measured for this container.'}
        </span>
      )}
    </li>
  );
}

/** One measurement as a bar, or an admission that there is none. */
function Meter({
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

  return (
    <span className="meter">
      <span className="meter__label">{label}</span>
      {/* Not drawn at all when nothing was measured. An empty bar and a bar at
          zero look the same and mean opposite things. */}
      {fraction === null || value === null ? (
        <span className="meter__value">Not measured</span>
      ) : (
        <>
          <span className="meter__track" aria-hidden="true">
            <span
              className={`meter__fill${fraction > 0.9 ? ' meter__fill--full' : ''}`}
              style={{ width: `${Math.round(fraction * 100)}%` }}
            />
          </span>
          <span className="meter__value">{format(value)}</span>
        </>
      )}
    </span>
  );
}

/**
 * Recent processor readings, as a row of bars.
 *
 * Deliberately tiny and deliberately not a charting library. What somebody
 * needs from a trend on this page is whether the line is going up, and a
 * hundred kilobytes of chart code would answer that no better than this does.
 */
function Trend({ history }: { history: WorkloadUsage[] }): React.JSX.Element | null {
  const readings = history.filter(
    (sample): sample is WorkloadUsage & { cpuMillicores: number } => sample.cpuMillicores !== null,
  );

  if (readings.length < 2) return null;

  return (
    <span className="trend" aria-label="Recent processor use">
      {readings.map((sample) => {
        const fraction = usageFraction(sample.cpuMillicores, sample.cpuLimitMillicores) ?? 0;
        return (
          <span
            key={sample.at}
            className="trend__bar"
            style={{ height: `${Math.max(Math.round(fraction * 100), 2)}%` }}
            title={`${sample.cpuMillicores} millicores at ${new Date(sample.at).toLocaleTimeString()}`}
          />
        );
      })}
    </span>
  );
}

/** Whether the application answered, in the words the page uses. */
function Health({ health }: { health: ApplicationHealth }): React.JSX.Element {
  const text =
    health.state === 'healthy'
      ? health.latencyMs === null
        ? 'Answering'
        : `Answering in ${health.latencyMs}ms`
      : health.state === 'unhealthy'
        ? `Answered with ${String(health.statusCode)}`
        : health.state === 'unreachable'
          ? 'Not answering'
          : 'Not checked';

  return (
    <span className={`health health--${health.state}`}>
      {text}
      {health.message ? ` — ${health.message}` : ''}
    </span>
  );
}

/** Bytes, in the unit a person would say out loud. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['kB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
