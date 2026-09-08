import { useCallback, useEffect, useState } from 'react';
import {
  DEPLOYMENT_TARGETS,
  DEPLOYMENT_TARGET_LABELS,
  deploymentConfigProblem,
  type DeploymentConfig,
  type DeploymentStateResponse,
  type DeploymentSummary,
  type DeploymentTarget,
} from '@platform/shared';
import { ApiError } from '../lib/api-client.js';
import {
  createDeployment,
  deleteDeployment,
  fetchDeploymentLog,
  fetchDeployments,
  setDeploymentConfig,
  rollbackDeployment,
  stopDeployment,
} from '../lib/deployments-api.js';

/**
 * How this project is deployed, and what has been.
 *
 * Deploying is a slow, destructive-feeling action with a lot going on behind
 * it, so the page is built around telling the truth about what happened: the
 * status of each release, the address it is served at, and what its build
 * printed. A failed build with no log would be a dead end.
 *
 * An installation with no deployment backend says so once, plainly, rather than
 * offering a button that fails. Saying how a project is built is still useful
 * there: it is a decision about the project rather than about a release.
 */
export function ProjectDeployments({
  projectId,
  addressNonce,
  onAddressChanged,
}: {
  projectId: string;
  /** Bumped when the project's address changed somewhere else on the page. */
  addressNonce: number;
  /** Called when deploying assigns an address the project did not have. */
  onAddressChanged: () => void;
}): React.JSX.Element {
  const [state, setState] = useState<DeploymentStateResponse | undefined>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [note, setNote] = useState('');
  const [confirming, setConfirming] = useState<string | undefined>();
  /** Which build's output is open, and what it said. */
  const [showingLog, setShowingLog] = useState<string | undefined>();
  const [logs, setLogs] = useState<Record<string, { log: string; truncated: boolean }>>({});

  /** The configuration being edited, which is the stored one until it is touched. */
  const [draft, setDraft] = useState<DeploymentConfig | undefined>();

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const next = await fetchDeployments(projectId, signal);
        if (signal?.aborted) return;
        setState(next);
        // The stored configuration, or the platform's reading of the project
        // when nobody has said. Never an empty form: a blank build command is
        // a worse starting point than a wrong one somebody can correct.
        setDraft(next.config ?? next.suggestion ?? BLANK);
        setError(undefined);
      } catch (cause) {
        if (signal?.aborted) return;
        setError(cause instanceof ApiError ? cause.message : 'Deployments could not be loaded.');
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
    // Reloaded when the address changes below, because this section is where
    // the address is shown.
  }, [load, addressNonce]);

  /*
   * Polled while a deployment is on its way.
   *
   * Building no longer happens inside the request that asked for it, so pressing
   * Deploy returns immediately with a deployment in REQUESTED. Without this the
   * page would sit on that until somebody reloaded, which would look exactly
   * like nothing having happened.
   *
   * Stops on its own once everything has settled.
   */
  const settling = state?.deployments.some(
    (deployment) =>
      deployment.status === 'REQUESTED' ||
      deployment.status === 'BUILDING' ||
      deployment.status === 'STARTING' ||
      deployment.status === 'STOPPING',
  );

  useEffect(() => {
    if (!settling) return;
    const timer = setInterval(() => void load(), 3_000);
    return () => clearInterval(timer);
  }, [settling, load]);

  const saveConfig = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (!draft) return;

    const problem = deploymentConfigProblem(draft);
    if (problem) {
      // The same check the server runs, so the answer is the same either way
      // and the round trip is spared.
      setError(problem);
      return;
    }

    setBusy(true);
    setError(undefined);
    try {
      setState(await setDeploymentConfig(projectId, draft));
    } catch (cause) {
      setError(
        cause instanceof ApiError ? cause.message : 'That configuration could not be saved.',
      );
    } finally {
      setBusy(false);
    }
  };

  const deploy = async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      await createDeployment(projectId, note ? { note } : {});
      setNote('');
      // A first deployment assigns the project's address, which the addresses
      // section below is showing.
      onAddressChanged();
      await load();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'This project could not be deployed.');
    } finally {
      setBusy(false);
    }
  };

  const stop = async (deployment: DeploymentSummary): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      await stopDeployment(projectId, deployment.id);
      await load();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'That deployment could not be stopped.');
    } finally {
      setBusy(false);
    }
  };

  const rollBack = async (deployment: DeploymentSummary): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      await rollbackDeployment(projectId, deployment.id);
      await load();
    } catch (cause) {
      setError(
        cause instanceof ApiError ? cause.message : 'That release could not be made live again.',
      );
    } finally {
      setBusy(false);
    }
  };

  const remove = async (deployment: DeploymentSummary): Promise<void> => {
    setBusy(true);
    setError(undefined);
    setConfirming(undefined);
    try {
      await deleteDeployment(projectId, deployment.id);
      await load();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'That deployment could not be removed.');
    } finally {
      setBusy(false);
    }
  };

  /** Fetches a build's output the first time it is opened. */
  const toggleLog = async (deployment: DeploymentSummary): Promise<void> => {
    if (showingLog === deployment.id) {
      setShowingLog(undefined);
      return;
    }

    setShowingLog(deployment.id);
    if (logs[deployment.id]) return;

    try {
      const fetched = await fetchDeploymentLog(projectId, deployment.id);
      setLogs((held) => ({ ...held, [deployment.id]: fetched }));
    } catch {
      // Shown as an empty log rather than as an error beside the deployment:
      // the list itself is still correct, and this is a detail somebody asked
      // for rather than something that failed on its own.
      setLogs((held) => ({ ...held, [deployment.id]: { log: '', truncated: false } }));
    }
  };

  const update = (change: Partial<DeploymentConfig>): void => {
    setDraft((current) => ({ ...(current ?? BLANK), ...change }));
  };

  const target = draft?.target ?? 'STATIC';

  return (
    <section className="project-section" aria-labelledby="deployments-heading">
      <h2 id="deployments-heading">Deployments</h2>
      <p className="project-section__hint">
        A deployment runs a fixed version of this project somewhere that outlives your workspace,
        reachable by people who do not have an account here. It is built from a copy of the files
        taken at the moment you deploy, so editing afterwards does not change what is running.
      </p>

      {/* Said once, in the place somebody would look for the button. */}
      {state?.unavailableReason && (
        <p className="project-section__error" role="status">
          {state.unavailableReason}
        </p>
      )}

      {/* Where this project answers, once it has an address. Shown before the
          list, because it is the thing somebody came here to find. */}
      {state?.url && (
        <p className="project-section__note">
          Published at{' '}
          <a href={state.url} target="_blank" rel="noreferrer noopener">
            {state.url}
          </a>
        </p>
      )}

      {loading && <p className="project-section__note">Loading deployments…</p>}

      {error && (
        <p className="project-section__error" role="alert">
          {error}
        </p>
      )}

      {draft && (
        <form className="project-section__form" onSubmit={(event) => void saveConfig(event)}>
          <label htmlFor="deployment-target">What this project is</label>
          <select
            id="deployment-target"
            value={target}
            onChange={(event) => {
              const next = event.target.value as DeploymentTarget;
              /*
               * Switching clears whichever fields no longer apply.
               *
               * A static site with a leftover start command is refused by both
               * the form and the server, and the person would have to work out
               * which invisible field was at fault.
               */
              update(
                next === 'STATIC'
                  ? { target: next, startCommand: null }
                  : { target: next, outputDirectory: null },
              );
            }}
          >
            {DEPLOYMENT_TARGETS.map((value) => (
              <option key={value} value={value}>
                {DEPLOYMENT_TARGET_LABELS[value]}
              </option>
            ))}
          </select>

          <label htmlFor="deployment-build">Build command</label>
          <input
            id="deployment-build"
            value={draft.buildCommand ?? ''}
            onChange={(event) => update({ buildCommand: event.target.value || null })}
            placeholder="Leave empty if there is nothing to build"
            autoComplete="off"
          />

          {target === 'STATIC' ? (
            <>
              <label htmlFor="deployment-output">Directory to serve</label>
              <input
                id="deployment-output"
                value={draft.outputDirectory ?? ''}
                onChange={(event) => update({ outputDirectory: event.target.value || null })}
                placeholder="dist"
                autoComplete="off"
              />
            </>
          ) : (
            <>
              <label htmlFor="deployment-start">Start command</label>
              <input
                id="deployment-start"
                value={draft.startCommand ?? ''}
                onChange={(event) => update({ startCommand: event.target.value || null })}
                placeholder="npm start"
                autoComplete="off"
              />
            </>
          )}

          <button type="submit" className="button-quiet" disabled={busy}>
            {busy ? 'Saving…' : 'Save deployment settings'}
          </button>
        </form>
      )}

      {/* Where the suggestion came from matters as much as the suggestion: one
          nobody can check is indistinguishable from an invention. */}
      {state && !state.config && state.suggestion && (
        <p className="project-section__note">
          These settings were read from this project&apos;s files. Nothing is saved until you press
          the button.
        </p>
      )}
      {state && !state.config && !state.suggestion && !loading && (
        <p className="project-section__note">
          This project does not say how it is built, so nothing is suggested. Fill the fields in.
        </p>
      )}

      {state?.config && !state.unavailableReason && (
        <form
          className="project-section__form"
          onSubmit={(event) => {
            event.preventDefault();
            void deploy();
          }}
        >
          <label htmlFor="deployment-note">Note</label>
          <input
            id="deployment-note"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="What is in this one"
            autoComplete="off"
          />
          <button type="submit" className="button-quiet" disabled={busy}>
            {busy ? 'Deploying…' : 'Deploy'}
          </button>
        </form>
      )}

      {state && state.deployments.length === 0 && !loading && (
        <p className="project-section__note">Nothing has been deployed yet.</p>
      )}

      {state && state.deployments.length > 0 && (
        <ul className="project-section__list">
          {state.deployments.map((deployment) => (
            <li key={deployment.id} className="project-section__item">
              <span className="project-section__item-name">
                {deployment.note ?? DEPLOYMENT_TARGET_LABELS[deployment.target]}
                {deployment.id === state.liveId ? ' — live' : ''}
              </span>
              <span className="project-section__item-meta">
                {statusLabel(deployment)} · {new Date(deployment.createdAt).toLocaleString()}
                {deployment.requestedBy ? ` by ${deployment.requestedBy}` : ''}
              </span>

              {deployment.url && (
                <a
                  className="project-section__item-value"
                  href={deployment.url}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  {deployment.url}
                </a>
              )}

              {/*
               * The release's own address, beside the project's.
               *
               * Shown only while it is running, because that is when it
               * answers. A release that has stopped keeps its label so history
               * can say what its address was, and the address stops working —
               * a link that looks live and 404s is worse than no link.
               */}
              {deployment.releaseUrl && (
                <a
                  className="project-section__item-meta"
                  href={deployment.releaseUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  this release only: {deployment.releaseUrl}
                </a>
              )}

              {deployment.rolledBackFromId && (
                <span className="project-section__item-meta">went back to an earlier release</span>
              )}

              {deployment.message && (
                <span className="project-section__item-value">{deployment.message}</span>
              )}

              {deployment.fileCount !== null && (
                <span className="project-section__item-meta">
                  {deployment.fileCount} {deployment.fileCount === 1 ? 'file' : 'files'}
                  {deployment.artifactBytes === null
                    ? ''
                    : `, ${formatBytes(deployment.artifactBytes)}`}
                </span>
              )}

              {deployment.hasLog && (
                <button
                  type="button"
                  className="icon-button"
                  onClick={() => void toggleLog(deployment)}
                >
                  {showingLog === deployment.id ? 'Hide build output' : 'Build output'}
                </button>
              )}

              {showingLog === deployment.id && <BuildOutput entry={logs[deployment.id]} />}

              {deployment.id === state.liveId ? (
                <button
                  type="button"
                  className="icon-button"
                  disabled={busy}
                  onClick={() => void stop(deployment)}
                >
                  Stop
                </button>
              ) : canRollBackTo(deployment) ? (
                <button
                  type="button"
                  className="icon-button"
                  disabled={busy}
                  onClick={() => void rollBack(deployment)}
                >
                  {/*
                   * Named for what it does, not "roll back".
                   *
                   * Somebody reading a list of releases is choosing one, and
                   * "make this live again" says which release they are choosing
                   * and what will happen. "Roll back" describes the situation
                   * they are in rather than the button.
                   */}
                  Make this live again
                </button>
              ) : confirming === deployment.id ? (
                <>
                  <button
                    type="button"
                    className="button-danger"
                    disabled={busy}
                    onClick={() => void remove(deployment)}
                  >
                    Yes, remove it
                  </button>
                  <button
                    type="button"
                    className="icon-button"
                    onClick={() => setConfirming(undefined)}
                  >
                    Keep it
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="icon-button"
                  disabled={busy}
                  onClick={() => setConfirming(deployment.id)}
                >
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * What a build printed.
 *
 * Shown as preformatted text and never as markup: it is the output of a command
 * somebody wrote, and rendering it would let a build script put anything it
 * liked on this page.
 */
function BuildOutput({
  entry,
}: {
  entry: { log: string; truncated: boolean } | undefined;
}): React.JSX.Element {
  if (!entry) return <p className="project-section__note">Loading the build output…</p>;
  if (entry.log.length === 0) {
    return <p className="project-section__note">This build printed nothing.</p>;
  }

  return (
    <>
      {entry.truncated && (
        <p className="project-section__note">
          Only the end of this build&apos;s output was kept. A build fails at the end, so this is
          the part that says why.
        </p>
      )}
      <pre className="build-log">{entry.log}</pre>
    </>
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

/** An empty configuration, used when there is nothing to start from. */
const BLANK: DeploymentConfig = {
  target: 'STATIC',
  buildCommand: null,
  outputDirectory: null,
  startCommand: null,
};

/** A status in the words the page uses, rather than the enum's. */
function statusLabel(deployment: DeploymentSummary): string {
  switch (deployment.status) {
    case 'REQUESTED':
      return 'Queued';
    case 'BUILDING':
      return 'Building';
    case 'STARTING':
      return 'Starting';
    case 'RUNNING':
      return 'Running';
    case 'STOPPING':
      return 'Stopping';
    case 'STOPPED':
      return 'Stopped';
    case 'FAILED':
      return 'Failed';
  }
}

/**
 * Whether there is anything to go back to in this release.
 *
 * A release that never finished building produced nothing, so making it live
 * again would mean building code that already failed to build. A static one is
 * identified by having produced files and a server one by having been frozen at
 * all — the same test the server applies, so the button is not offered for
 * something the server would refuse.
 */
function canRollBackTo(deployment: DeploymentSummary): boolean {
  if (deployment.status === 'RUNNING') return false;
  if (deployment.target === 'STATIC') return deployment.fileCount !== null;
  return deployment.snapshotId !== null;
}
