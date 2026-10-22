import { useEffect, useState, type FormEvent } from 'react';
import { MAX_RUN_COMMAND_LENGTH, type RunState } from '@platform/shared';
import { Field } from '../../components/Field.js';
import { ApiError } from '../../lib/api-client.js';
import { fetchRunState, setRunCommand } from '../../lib/runtime-api.js';
import { useAction } from '../../lib/use-action.js';
import { useResource } from '../../lib/use-resource.js';
import { Play } from '../../ui/icons.js';
import { Button, Callout, SectionHeader, Skeleton, toast } from '../../ui/index.js';
import './run.css';

export function RunCommandSection({
  projectId,
  canControl,
}: {
  projectId: string;
  canControl: boolean;
}): React.JSX.Element {
  const read = useResource((signal) => fetchRunState(projectId, signal), [projectId]);
  const [draft, setDraft] = useState('');
  const [dirty, setDirty] = useState(false);
  const [fieldError, setFieldError] = useState<string | undefined>();

  const configured = read.data?.configuredCommand ?? '';
  useEffect(() => {
    if (!dirty) setDraft(configured);
  }, [configured, dirty]);

  const save = useAction(async (command: string | null) => {
    const next = await setRunCommand(projectId, command);
    return next;
  });

  const running = read.data?.status === 'RUNNING' || read.data?.status === 'STARTING';
  const lockedReason = !canControl
    ? 'Only editors and the owner can change what this project runs'
    : running
      ? 'Stop the app before changing what it runs'
      : undefined;

  const apply = async (command: string | null, note: string): Promise<void> => {
    setFieldError(undefined);
    const outcome = await save.run(command);
    if (!outcome.ok) {
      setFieldError(
        outcome.error instanceof ApiError
          ? outcome.error.message
          : 'The run command could not be saved.',
      );
      return;
    }
    setDirty(false);
    setDraft(outcome.value.configuredCommand ?? '');
    toast({ tone: 'success', title: note });
    read.reload();
  };

  const onSubmit = (event: FormEvent): void => {
    event.preventDefault();
    const trimmed = draft.trim();
    void apply(
      trimmed === '' ? null : trimmed,
      trimmed === '' ? 'Using the suggested command' : 'Run command saved',
    );
  };

  return (
    <section className="run-section" aria-labelledby="run-command-heading">
      <SectionHeader
        title={<span id="run-command-heading">Run command</span>}
        icon={Play}
        description="What Run starts inside the environment. The console edits the same value."
      />

      {read.status === 'loading' && !read.data ? (
        <div className="run-form" aria-busy="true">
          <Skeleton height={12} width={120} />
          <Skeleton shape="row" />
        </div>
      ) : read.status === 'error' && !read.data ? (
        <Callout
          tone="danger"
          title={
            read.error instanceof ApiError
              ? read.error.message
              : 'The run command could not be loaded.'
          }
          action={
            <Button size="sm" onClick={read.reload}>
              Retry
            </Button>
          }
        />
      ) : (
        <form className="run-form" onSubmit={onSubmit} noValidate>
          <Field
            id="run-command"
            label="Run command"
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              setDirty(true);
              if (fieldError) setFieldError(undefined);
            }}
            placeholder={read.data?.suggestion?.command ?? 'A command to run'}
            maxLength={MAX_RUN_COMMAND_LENGTH}
            mono
            autoComplete="off"
            error={fieldError}
            hint={describeSource(read.data)}
            {...(lockedReason ? { disabledReason: lockedReason } : {})}
          />
          <div className="run-form__actions">
            <Button
              type="submit"
              loading={save.busy}
              {...(lockedReason
                ? { disabledReason: lockedReason }
                : !dirty
                  ? { disabledReason: 'Nothing has changed yet' }
                  : {})}
            >
              Save
            </Button>
            {read.data?.configuredCommand && read.data.suggestion ? (
              <Button
                variant="ghost"
                loading={save.busy}
                onClick={() => void apply(null, 'Using the suggested command')}
                {...(lockedReason ? { disabledReason: lockedReason } : {})}
              >
                Use the suggestion
              </Button>
            ) : null}
          </div>
        </form>
      )}
    </section>
  );
}

function describeSource(state: RunState | undefined): string {
  if (!state) return '';
  if (state.configuredCommand) {
    return state.suggestion
      ? `Set for this project. The platform would otherwise run "${state.suggestion.command}", from ${state.suggestion.reason}.`
      : 'Set for this project.';
  }
  if (state.suggestion) {
    return `Suggested by the platform, from ${state.suggestion.reason}. Leave this empty to keep using the suggestion.`;
  }
  return 'The platform cannot tell how to start this project. Tell it what to run.';
}
