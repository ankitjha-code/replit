import { useHealth } from '../lib/use-health.js';

/**
 * Baseline page. It renders only what the control plane actually reports: if
 * no dependency is registered yet, it says so rather than inventing rows.
 */
export function SystemStatusPage(): React.JSX.Element {
  const health = useHealth();

  return (
    <div className="panel">
      <h1>Control plane</h1>
      <p>Live readiness reported by the API. Dependencies appear here as they are introduced.</p>

      {health.status === 'loading' && <p className="empty-note">Contacting the control plane…</p>}

      {health.status === 'error' && (
        <div className="status-row">
          <span className="status-dot status-dot--down" aria-hidden="true" />
          <span>api</span>
          <span className="status-row__detail">{health.message}</span>
        </div>
      )}

      {health.status === 'ready' && (
        <>
          <div className="status-row">
            <span
              className={`status-dot status-dot--${health.data.status === 'ok' ? 'ok' : health.data.status === 'degraded' ? 'degraded' : 'down'}`}
              aria-hidden="true"
            />
            <span>{health.data.service}</span>
            <span className="status-row__detail">
              v{health.data.version} · up {health.data.uptimeSeconds}s
            </span>
          </div>

          {health.data.dependencies.length === 0 ? (
            <p className="empty-note">No dependencies registered yet.</p>
          ) : (
            health.data.dependencies.map((dep) => (
              <div className="status-row" key={dep.name}>
                <span
                  className={`status-dot status-dot--${dep.status === 'up' ? 'ok' : dep.status === 'unknown' ? 'degraded' : 'down'}`}
                  aria-hidden="true"
                />
                <span>{dep.name}</span>
                <span className="status-row__detail">
                  {dep.detail ?? (dep.latencyMs === undefined ? '' : `${dep.latencyMs}ms`)}
                </span>
              </div>
            ))
          )}
        </>
      )}
    </div>
  );
}
