import { RUNTIME_DEFINITIONS, type RuntimeStateResponse } from '@platform/shared';
import type { RuntimeControls as RuntimeControlsState } from './use-runtime.js';

/**
 * The runtime's state, and the one action available on it.
 *
 * Every word here comes from the server. The rule this surface exists to keep
 * is that a project is never shown as running until the platform has actually
 * started it, and that "cannot run" is distinguished from "not running yet",
 * because they need different things from the person reading them.
 */
export function RuntimeControls({
  runtime,
  canControl,
}: {
  /** Owned by the workspace, because the console needs the same state. */
  runtime: RuntimeControlsState;
  canControl: boolean;
}): React.JSX.Element {
  const { state, busy, loading, error } = runtime;

  const status = state?.runtime?.status;
  const running = status === 'RUNNING';
  const settling = status !== undefined && TRANSITIONAL.has(status);
  const unavailable = state ? !state.provider.available : false;

  const label = statusLabel(state, loading);
  const blockedReason = disabledReason({ state, canControl, settling, busy, loading });

  return (
    <div className="runtime-controls">
      <span className={`runtime-chip runtime-chip--${tone(state, loading)}`} title={detail(state)}>
        <span className="runtime-chip__dot" aria-hidden="true" />
        {label}
      </span>

      {/* The failure the runtime is sitting in, which outlives the request
          that caused it and is what someone comes back to. */}
      {state?.runtime?.message && !error && (
        <span className="runtime-controls__message" role="status">
          {state.runtime.message}
        </span>
      )}

      {/* The last action's own failure, which the runtime row may not record:
          a refusal happens before anything is written. */}
      {error && (
        <span className="runtime-controls__message" role="alert">
          {error}
        </span>
      )}

      <button
        type="button"
        className="button-quiet"
        disabled={blockedReason !== undefined}
        title={
          blockedReason ??
          (running
            ? "Stop this project's environment"
            : "Start this project's environment, so it can run and take a terminal")
        }
        onClick={() => void (running ? runtime.stop() : runtime.start())}
      >
        {/*
          "Start", not "Run". The console has a Run button that starts the
          project's own application, and two identically named buttons doing
          different things is worse than a slightly less obvious word.
        */}
        {running ? 'Stop' : 'Start'}
      </button>

      {/* Disabled controls announce nothing, so the reason is given as text a
          screen reader reaches. */}
      {blockedReason && !busy && !loading && (
        <span className="visually-hidden" role="status">
          {blockedReason}
        </span>
      )}

      {unavailable && (
        <span className="visually-hidden">Running is not available on this installation.</span>
      )}
    </div>
  );
}

const TRANSITIONAL = new Set(['REQUESTED', 'CREATING', 'STARTING', 'STOPPING']);

/** What the chip says. Never more certain than the server was. */
function statusLabel(state: RuntimeStateResponse | undefined, loading: boolean): string {
  if (loading || !state) return 'Checking…';

  switch (state.runtime?.status) {
    case 'REQUESTED':
    case 'CREATING':
    case 'STARTING':
      return 'Starting…';
    case 'RUNNING':
      return 'Running';
    case 'STOPPING':
      return 'Stopping…';
    case 'FAILED':
      return 'Failed';
    case 'STOPPED':
      return 'Stopped';
    default:
      // No runtime has ever existed for this project. Whether that is because
      // nobody started one or because nothing can be started is a different
      // fact, and the two read differently.
      return state.provider.available ? 'Not running' : 'Running unavailable';
  }
}

function tone(state: RuntimeStateResponse | undefined, loading: boolean): string {
  if (loading || !state) return 'idle';
  switch (state.runtime?.status) {
    case 'RUNNING':
      return 'running';
    case 'REQUESTED':
    case 'CREATING':
    case 'STARTING':
    case 'STOPPING':
      return 'pending';
    case 'FAILED':
      return 'failed';
    default:
      return 'idle';
  }
}

/** The hover detail: what this project is, and what it would run on. */
function detail(state: RuntimeStateResponse | undefined): string {
  if (!state) return 'Checking the runtime';
  if (!state.provider.available) {
    return state.provider.reason ?? 'Running is not available on this installation.';
  }

  const runtime = state.runtime;
  if (runtime) {
    const name = RUNTIME_DEFINITIONS[runtime.language].displayName;
    return `${name} ${runtime.version}`;
  }

  const detected = state.detected;
  if (!detected) return 'This project does not say which runtime it needs.';

  const name = RUNTIME_DEFINITIONS[detected.language].displayName;
  return `${name} ${detected.version}, from ${detected.evidence}`;
}

/**
 * Why the button cannot be pressed, or undefined when it can.
 *
 * A single function so the disabled state and the explanation cannot disagree:
 * a control that is disabled for a reason nobody states is the thing people
 * file bugs about.
 */
function disabledReason(input: {
  state: RuntimeStateResponse | undefined;
  canControl: boolean;
  settling: boolean;
  busy: boolean;
  loading: boolean;
}): string | undefined {
  if (input.loading || !input.state) return 'Checking whether this project is running.';
  if (input.busy) return 'Working on it.';
  if (!input.canControl) return 'You have read-only access to this project.';
  if (!input.state.provider.available) {
    return input.state.provider.reason ?? 'Running is not available on this installation.';
  }
  if (input.settling) return 'The runtime is still changing state.';
  if (!input.state.runtime && !input.state.detected) {
    return 'This project does not say which runtime it needs. Add a manifest such as package.json.';
  }
  return undefined;
}
