import { useCallback, useEffect, useState } from 'react';
import type { AlertKind, AlertResponse } from '@platform/shared';
import { fetchAlerts, updateAlerts } from '../lib/alerts-api.js';
import { ApiError } from '../lib/api-client.js';

const KIND_LABELS: Record<AlertKind, string> = {
  HEALTH: 'Health check',
  MEMORY: 'Memory',
};

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
  const [state, setState] = useState<AlertResponse | undefined>();
  const [enabled, setEnabled] = useState(false);
  const [failures, setFailures] = useState('3');
  const [memory, setMemory] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [saved, setSaved] = useState(false);

  const adopt = useCallback((next: AlertResponse) => {
    setState(next);
    setEnabled(next.settings.enabled);
    setFailures(String(next.settings.failuresBeforeAlert));
    setMemory(next.settings.memoryPercent === null ? '' : String(next.settings.memoryPercent));
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    fetchAlerts(projectId, controller.signal)
      .then((loaded) => {
        if (!controller.signal.aborted) adopt(loaded);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setError(cause instanceof ApiError ? cause.message : 'Alerts could not be loaded.');
      });
    return () => controller.abort();
  }, [projectId, adopt]);

  const save = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    setSaved(false);
    try {
      adopt(
        await updateAlerts(projectId, {
          enabled,
          failuresBeforeAlert: Number(failures),
          memoryPercent: memory.trim() === '' ? null : Number(memory),
        }),
      );
      setSaved(true);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'Alerts could not be saved.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="project-section" aria-labelledby="alerts-heading">
      <h2 id="alerts-heading">Alerts</h2>
      <p className="project-section__hint">
        An email to the project&apos;s owner when the deployment stops passing its health check or
        runs close to its memory limit, and another when it recovers. Never one per check.
      </p>

      {state?.deliveryProblem && (
        <p className="project-section__error" role="status">
          {state.deliveryProblem}
        </p>
      )}

      {state && state.firing.length > 0 && (
        <p className="project-section__error" role="alert">
          Firing now: {state.firing.map((kind) => KIND_LABELS[kind]).join(', ')}
        </p>
      )}

      {canEdit && state && (
        <form className="project-section__form" onSubmit={(event) => void save(event)}>
          <label>
            <input
              type="checkbox"
              checked={enabled}
              onChange={(event) => setEnabled(event.target.checked)}
            />{' '}
            Alerts on
          </label>
          <label htmlFor="alert-failures">Failed checks in a row before alerting</label>
          <input
            id="alert-failures"
            type="number"
            min={1}
            max={20}
            value={failures}
            onChange={(event) => setFailures(event.target.value)}
          />
          <label htmlFor="alert-memory">Memory alert at % of the limit (blank for none)</label>
          <input
            id="alert-memory"
            type="number"
            min={50}
            max={100}
            value={memory}
            onChange={(event) => setMemory(event.target.value)}
          />
          <button type="submit" className="button-quiet" disabled={busy}>
            {busy ? 'Saving…' : 'Save alerts'}
          </button>
        </form>
      )}

      {saved && (
        <p className="project-section__note" role="status">
          Saved. Anything that was firing starts again from a clean slate.
        </p>
      )}

      {error && (
        <p className="project-section__error" role="alert">
          {error}
        </p>
      )}

      {state && (
        <p className="project-section__note">
          {state.lastCheckedAt
            ? `Last checked ${new Date(state.lastCheckedAt).toLocaleString()}.`
            : state.settings.enabled
              ? 'Not checked yet. Checks are made by the worker process.'
              : 'Alerts are off.'}
        </p>
      )}

      {state && state.events.length > 0 && (
        <ul className="project-section__list">
          {state.events.map((event) => (
            <li key={event.id} className="project-section__item">
              <span className="project-section__item-name">
                {KIND_LABELS[event.kind]} {event.state === 'FIRING' ? 'alert' : 'cleared'}
              </span>
              <span className="project-section__item-meta">
                {new Date(event.at).toLocaleString()} · {event.notified ? 'emailed' : 'not emailed'}
              </span>
              <span className="project-section__item-value">{event.message}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
