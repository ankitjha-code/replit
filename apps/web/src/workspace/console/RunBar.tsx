import { useId, useState, type Ref } from 'react';
import { MAX_RUN_COMMAND_LENGTH, type RunStatus } from '@platform/shared';
import { Badge, Button, Callout, IconButton, Input, Spinner, Tooltip } from '../../ui/index.js';
import { ArrowClockwise, PencilSimple, Play, Stop } from '../../ui/icons.js';
import type { RunControls } from './use-run.js';

export const READ_ONLY_REASON = 'You have read-only access to this project.';
export const START_FIRST_REASON = 'Start the environment first.';

export interface RunBarProps {
  run: RunControls;
  canControl: boolean;
  runtimeRunning: boolean;
  editing: boolean;
  onEditingChange: (editing: boolean) => void;
  runRef?: Ref<HTMLButtonElement>;
  compact?: boolean;
  demoted?: boolean;
}

export function appIsLive(status: RunStatus | undefined, runtimeRunning: boolean): boolean {
  return runtimeRunning && (status === 'RUNNING' || status === 'STARTING');
}

export function runBlockedReason(
  run: RunControls,
  canControl: boolean,
  runtimeRunning: boolean,
): string | undefined {
  if (!canControl) return READ_ONLY_REASON;
  if (!runtimeRunning) return START_FIRST_REASON;
  if (!run.state) return run.loading ? 'Checking whether the app can run.' : undefined;
  return run.state.blockedReason ?? undefined;
}

export function RunBar({
  run,
  canControl,
  runtimeRunning,
  editing,
  onEditingChange,
  runRef,
  compact = false,
  demoted = false,
}: RunBarProps): React.JSX.Element {
  const status = run.state?.status;
  const live = appIsLive(status, runtimeRunning);
  const blocked = runBlockedReason(run, canControl, runtimeRunning);
  const [runTip, setRunTip] = useState(false);

  return (
    <div
      className={`run-bar${compact ? ' run-bar--compact' : ''}`}
      role="group"
      aria-label="App controls"
    >
      <span className="run-bar__label" aria-hidden="true">
        App
      </span>

      {editing && canControl ? (
        <CommandForm run={run} onClose={() => onEditingChange(false)} />
      ) : compact ? null : (
        <CommandField
          run={run}
          live={live}
          canControl={canControl}
          onEdit={() => onEditingChange(true)}
        />
      )}

      <div className="run-bar__state">
        <StatusBadge
          status={runtimeRunning ? status : quiet(status)}
          exitCode={run.state?.exitCode}
        />
        {run.connection === 'reconnecting' ? (
          <span className="run-bar__caption" role="status">
            <Spinner size={12} aria-hidden="true" />
            Reconnecting to output…
          </span>
        ) : null}

        {live ? (
          <>
            {canControl ? (
              <IconButton
                size="sm"
                label="Restart app"
                icon={ArrowClockwise}
                shortcut={['Mod', 'Shift', 'R']}
                disabled={run.busy}
                onClick={() => void run.restart()}
              />
            ) : null}
            <Tooltip content="Stop the app" shortcut={['Mod', 'Shift', 'Enter']}>
              <Button
                ref={runRef}
                size="sm"
                variant="secondary"
                className="run-bar__stop"
                icon={Stop}
                loading={run.busy}
                {...(canControl
                  ? {}
                  : { disabledReason: READ_ONLY_REASON, title: READ_ONLY_REASON })}
                onClick={() => void run.stop()}
              >
                Stop
              </Button>
            </Tooltip>
          </>
        ) : (
          <Tooltip
            content="Run the app"
            shortcut={['Mod', 'Enter']}
            open={blocked ? false : runTip}
            onOpenChange={setRunTip}
          >
            <Button
              ref={runRef}
              size="sm"
              variant={blocked || demoted ? 'secondary' : 'primary'}
              icon={Play}
              loading={!blocked && run.busy}
              keepReasonWrapper
              {...(blocked
                ? {
                    disabledReason: blocked,
                    title: blocked,
                  }
                : {})}
              onClick={() => void run.start()}
            >
              Run
            </Button>
          </Tooltip>
        )}
      </div>
    </div>
  );
}

function quiet(status: RunStatus | undefined): RunStatus | undefined {
  return status === 'RUNNING' || status === 'STARTING' ? 'IDLE' : status;
}

export function StatusBadge({
  status,
  exitCode,
}: {
  status: RunStatus | undefined;
  exitCode: number | null | undefined;
}): React.JSX.Element {
  switch (status) {
    case 'STARTING':
      return (
        <Badge tone="warn" dot className="run-bar__status">
          Starting…
        </Badge>
      );
    case 'RUNNING':
      return (
        <Badge tone="ok" dot className="run-bar__status">
          Running
        </Badge>
      );
    case 'EXITED':
      return (
        <span className="run-bar__status-group">
          <Badge tone="neutral" className="run-bar__status">
            Stopped
          </Badge>
          {exitCode === 0 ? <Badge tone="ok">exit 0</Badge> : null}
        </span>
      );
    case 'FAILED':
      return (
        <Badge tone="danger" className="run-bar__status">
          {exitCode === null || exitCode === undefined ? 'Failed' : `Exited ${exitCode}`}
        </Badge>
      );
    default:
      return (
        <Badge tone="neutral" className="run-bar__status">
          Not running
        </Badge>
      );
  }
}

export function shownCommand(run: RunControls, live: boolean): string | undefined {
  const state = run.state;
  if (!state) return undefined;
  if (live) return state.command ?? state.configuredCommand ?? state.suggestion?.command;
  return state.configuredCommand ?? state.suggestion?.command ?? state.command ?? undefined;
}

function commandTitle(run: RunControls, live: boolean): string {
  const state = run.state;
  if (!state) return '';
  if (live && state.command) return 'The command this run was started with';
  if (state.configuredCommand) return 'Set for this project';
  if (state.suggestion) return `Suggested by the platform, from ${state.suggestion.reason}`;
  return '';
}

function CommandField({
  run,
  live,
  canControl,
  onEdit,
}: {
  run: RunControls;
  live: boolean;
  canControl: boolean;
  onEdit: () => void;
}): React.JSX.Element {
  const command = shownCommand(run, live);
  const state = run.state;
  const provenance =
    live || !state
      ? undefined
      : state.configuredCommand
        ? 'Set'
        : state.suggestion
          ? 'Suggested'
          : undefined;

  return (
    <div className="run-bar__command-row">
      {command ? (
        <code className="run-bar__command" title={commandTitle(run, live)}>
          {command}
        </code>
      ) : (
        <span className="run-bar__command run-bar__command--none">Not set</span>
      )}
      {provenance ? <Badge tone="neutral">{provenance}</Badge> : null}
      {canControl && state ? (
        <Button
          size="sm"
          variant="ghost"
          icon={PencilSimple}
          {...(live
            ? { disabledReason: 'Stop the app before changing what it runs.' }
            : run.busy
              ? { disabled: true }
              : {})}
          onClick={onEdit}
        >
          Edit
        </Button>
      ) : null}
    </div>
  );
}

function CommandForm({
  run,
  onClose,
}: {
  run: RunControls;
  onClose: () => void;
}): React.JSX.Element {
  const [draft, setDraft] = useState(run.state?.configuredCommand ?? '');
  const [error, setError] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);
  const inputId = useId();
  const errorId = useId();

  return (
    <form
      className="run-bar__form"
      onSubmit={(event) => {
        event.preventDefault();
        const trimmed = draft.trim();
        setSaving(true);
        setError(undefined);
        run
          .setCommand(trimmed === '' ? null : trimmed)
          .then(onClose, (cause: unknown) => {
            setError(
              cause instanceof Error ? cause.message : 'The run command could not be saved.',
            );
          })
          .finally(() => setSaving(false));
      }}
    >
      <label className="visually-hidden" htmlFor={inputId}>
        Run command
      </label>
      <Input
        id={inputId}
        size="sm"
        mono
        className="run-bar__input"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        placeholder={run.state?.suggestion?.command ?? 'A command to run'}
        maxLength={MAX_RUN_COMMAND_LENGTH}
        invalid={error !== undefined}
        {...(error ? { 'aria-describedby': errorId } : {})}
        autoFocus
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            onClose();
          }
        }}
      />
      <Button type="submit" size="sm" variant="secondary" loading={saving}>
        Save
      </Button>
      <Button size="sm" variant="ghost" onClick={onClose}>
        Cancel
      </Button>
      {error ? (
        <Callout tone="danger" className="run-bar__form-error" id={errorId}>
          {error}
        </Callout>
      ) : null}
    </form>
  );
}
