import { useEffect, useState, type ReactElement, type Ref } from 'react';
import {
  RUNTIME_DEFINITIONS,
  type RuntimeLanguage,
  type RuntimeStateResponse,
} from '@platform/shared';
import { formatDuration } from '../lib/format.js';
import { Button, Callout, ConfirmDialog, IconButton, Progress, StatusDot } from '../ui/index.js';
import { Info } from '../ui/icons.js';
import type { Tone } from '../ui/index.js';
import { EnvironmentPopover } from './shell/EnvironmentPopover.js';
import {
  LanguagePickerDialog,
  forgetLanguage,
  readRememberedLanguage,
  rememberLanguage,
} from './shell/LanguagePickerDialog.js';
import type { RuntimeControls as RuntimeControlsState } from './use-runtime.js';

export interface RuntimeControlsProps {
  runtime: RuntimeControlsState;
  canControl: boolean;
  projectId?: string;
  appRunning?: boolean;
  startRef?: Ref<HTMLButtonElement>;
  compact?: boolean;
}

const STILL_STARTING_MS = 20_000;

export const STILL_STARTING_MESSAGE = 'Still starting. This can take a minute the first time.';
export const CHOOSE_LANGUAGE_TITLE = 'Choose what this project runs.';
export const LOAD_ERROR_TITLE = 'Could not read the environment state.';

export function RuntimeControls({
  runtime,
  canControl,
  projectId,
  appRunning = false,
  startRef,
  compact = false,
}: RuntimeControlsProps): ReactElement {
  const { state, busy, loading, error, loadError } = runtime;

  const status = state?.runtime?.status;
  const running = status === 'RUNNING';
  const starting = status === 'REQUESTED' || status === 'CREATING' || status === 'STARTING';
  const stopping = status === 'STOPPING';
  const unavailable = state ? !state.provider.available : false;
  const undetected = state !== undefined && !state.runtime && !state.detected;

  const [pickerOpen, setPickerOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const stillStarting = useElapsed(starting, STILL_STARTING_MS);
  const uptime = useUptime(running ? state?.runtime?.startedAt : null);

  const label = statusLabel(state, loading);
  const chipTone = tone(state, loading);
  const detailText = detail(state);
  const blockedReason = disabledReason({ state, canControl, loading });

  const showStop = running || starting || stopping;

  const startWith = async (language?: RuntimeLanguage): Promise<void> => {
    if (language && projectId) rememberLanguage(projectId, language);
    await runtime.start(language);
  };

  const onStart = (): void => {
    if (!undetected) {
      void startWith();
      return;
    }
    const remembered = projectId ? readRememberedLanguage(projectId) : undefined;
    if (remembered) void startWith(remembered);
    else setPickerOpen(true);
  };

  const onStop = (): void => {
    if (running && appRunning) {
      setConfirmStop(true);
      return;
    }
    void runtime.stop();
  };

  const changeLanguage = (): void => {
    if (projectId) forgetLanguage(projectId);
    setDetailsOpen(false);
    setPickerOpen(true);
  };

  const title = blockedReason ?? (showStop ? 'Stop the environment' : startTitle(state));

  return (
    <>
      <div
        role="group"
        aria-label="Environment controls"
        className={`env-control${compact ? ' env-control--compact' : ''}`}
      >
        {compact ? null : (
          <span className="env-control__label" aria-hidden="true">
            Environment
          </span>
        )}

        <span className={`runtime-chip runtime-chip--${chipTone}`} title={detailText}>
          <StatusDot
            tone={dotTone(chipTone)}
            pulse={chipTone === 'pending' || chipTone === 'idle-loading'}
            label=""
            aria-hidden="true"
          />
          {label}
        </span>

        {uptime ? (
          <span className="env-control__uptime" title="Running for">
            · {uptime}
          </span>
        ) : null}

        {!compact && detailText && !showStop ? (
          <span className="env-control__detail">{detailText}</span>
        ) : null}

        <Button
          {...(startRef ? { ref: startRef } : {})}
          variant={showStop ? 'secondary' : 'primary'}
          size="sm"
          className={`env-control__action${showStop ? ' env-control__action--stop' : ''}`}
          loading={busy || stopping}
          {...(stopping ? { loadingLabel: 'Stopping the environment' } : {})}
          title={title}
          disabled={stopping}
          keepReasonWrapper
          {...(blockedReason ? { disabledReason: blockedReason } : {})}
          onClick={showStop ? onStop : onStart}
        >
          {showStop ? 'Stop' : 'Start'}
        </Button>

        <EnvironmentPopover
          projectId={projectId}
          state={state}
          open={detailsOpen}
          onOpenChange={setDetailsOpen}
          {...(canControl && !state?.runtime ? { onChangeLanguage: changeLanguage } : {})}
          trigger={
            <IconButton
              label="Environment details"
              icon={Info}
              size="sm"
              className="env-control__details"
            />
          }
        />

        {blockedReason && !busy && !loading && (
          <span className="visually-hidden" role="status">
            {blockedReason}
          </span>
        )}

        {unavailable && (
          <span className="visually-hidden">Running is not available on this installation.</span>
        )}
      </div>

      <EnvironmentNotices
        state={state}
        loadError={loadError}
        error={error}
        starting={starting}
        stillStarting={stillStarting}
        onRetry={() => void runtime.refresh()}
        onDetails={() => setDetailsOpen(true)}
      />

      <LanguagePickerDialog open={pickerOpen} onOpenChange={setPickerOpen} onStart={startWith} />

      <ConfirmDialog
        open={confirmStop}
        onOpenChange={setConfirmStop}
        title="Stop the environment?"
        body="The app and any open shells stop too. Your files are kept."
        confirmLabel="Stop environment"
        tone="danger"
        onConfirm={() => runtime.stop()}
      />
    </>
  );
}

function EnvironmentNotices({
  state,
  loadError,
  error,
  starting,
  stillStarting,
  onRetry,
  onDetails,
}: {
  state: RuntimeStateResponse | undefined;
  loadError: string | undefined;
  error: string | undefined;
  starting: boolean;
  stillStarting: boolean;
  onRetry: () => void;
  onDetails: () => void;
}): ReactElement | null {
  const notices: ReactElement[] = [];

  if (loadError && !state) {
    notices.push(
      <Callout
        key="load"
        tone="danger"
        title={LOAD_ERROR_TITLE}
        action={
          <Button size="sm" onClick={onRetry}>
            Retry
          </Button>
        }
      >
        {loadError}
      </Callout>,
    );
  }

  if (state && !state.provider.available) {
    notices.push(
      <Callout key="provider" tone="info">
        {state.provider.reason ?? 'Running is not available on this installation.'}
      </Callout>,
    );
  }

  if (error) {
    notices.push(
      <Callout key="action" tone="danger">
        {error}
      </Callout>,
    );
  }

  if (state?.runtime?.status === 'FAILED' && state.runtime.message) {
    notices.push(
      <Callout
        key="failed"
        tone="danger"
        title="The environment could not start."
        action={
          <Button size="sm" onClick={onDetails}>
            Details
          </Button>
        }
      >
        {state.runtime.message}
      </Callout>,
    );
  }

  if (starting && state?.runtime) {
    notices.push(
      <div key="starting" className="env-notices__starting" role="status">
        <Progress indeterminate label="Starting the environment" />
        <span className="env-notices__step">
          {state.runtime.message ?? 'Creating the environment…'}
          {stillStarting ? ` ${STILL_STARTING_MESSAGE}` : ''}
        </span>
      </div>,
    );
  }

  if (notices.length === 0) return null;
  return <div className="env-notices">{notices}</div>;
}

function useElapsed(active: boolean, ms: number): boolean {
  const [elapsed, setElapsed] = useState(false);
  useEffect(() => {
    if (!active) {
      setElapsed(false);
      return;
    }
    const timer = setTimeout(() => setElapsed(true), ms);
    return () => clearTimeout(timer);
  }, [active, ms]);
  return elapsed;
}

function useUptime(startedAt: string | null | undefined): string | undefined {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!startedAt) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [startedAt]);
  if (!startedAt) return undefined;
  const started = new Date(startedAt).getTime();
  if (Number.isNaN(started)) return undefined;
  return formatDuration(Math.max(0, (now - started) / 1000));
}

export function statusLabel(state: RuntimeStateResponse | undefined, loading: boolean): string {
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
      return state.provider.available ? 'Not running' : 'Running unavailable';
  }
}

type ChipTone = 'idle' | 'idle-loading' | 'pending' | 'running' | 'failed';

function tone(state: RuntimeStateResponse | undefined, loading: boolean): ChipTone {
  if (loading || !state) return 'idle-loading';
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

function dotTone(chip: ChipTone): Tone {
  switch (chip) {
    case 'running':
      return 'ok';
    case 'pending':
      return 'warn';
    case 'failed':
      return 'danger';
    default:
      return 'neutral';
  }
}

export function detail(state: RuntimeStateResponse | undefined): string {
  if (!state) return 'Checking the environment';
  if (!state.provider.available) {
    return state.provider.reason ?? 'Running is not available on this installation.';
  }

  const runtime = state.runtime;
  if (runtime) {
    const name = RUNTIME_DEFINITIONS[runtime.language].displayName;
    if (runtime.status === 'STOPPED' && runtime.startedAt && runtime.stoppedAt) {
      const seconds =
        (new Date(runtime.stoppedAt).getTime() - new Date(runtime.startedAt).getTime()) / 1000;
      if (Number.isFinite(seconds) && seconds > 0) {
        return `Ran for ${formatDuration(seconds)}`;
      }
    }
    return `${name} ${runtime.version}`;
  }

  const detected = state.detected;
  if (!detected) return 'Choose what this project runs';

  const name = RUNTIME_DEFINITIONS[detected.language].displayName;
  return `${name} ${detected.version}, from ${detected.evidence}`;
}

function startTitle(state: RuntimeStateResponse | undefined): string {
  if (state && !state.runtime && !state.detected) return CHOOSE_LANGUAGE_TITLE;
  return detail(state);
}

export function disabledReason(input: {
  state: RuntimeStateResponse | undefined;
  canControl: boolean;
  loading: boolean;
}): string | undefined {
  if (input.loading || !input.state) return 'Checking whether this project is running.';
  if (!input.canControl) return 'You have read-only access to this project.';
  if (!input.state.provider.available) {
    return input.state.provider.reason ?? 'Running is not available on this installation.';
  }
  return undefined;
}
