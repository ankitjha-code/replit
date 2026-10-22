import { useRef, useState, type FormEvent } from 'react';
import {
  parseDotenv,
  type ImportEnvironmentResponse,
  type ProjectVariable,
} from '@platform/shared';
import { Field } from '../components/Field.js';
import { ApiError } from '../lib/api-client.js';
import { fieldErrorsFrom } from '../lib/form-errors.js';
import {
  deleteVariable,
  fetchVariables,
  importEnvironment,
  setVariable,
} from '../lib/project-storage-api.js';
import { useAction } from '../lib/use-action.js';
import { useResource } from '../lib/use-resource.js';
import { PencilSimple, SlidersHorizontal, Trash, UploadSimple } from '../ui/icons.js';
import {
  Button,
  Callout,
  Checkbox,
  ConfirmDialog,
  Dialog,
  Input,
  RelativeTime,
  SectionHeader,
  Table,
  Textarea,
  toast,
} from '../ui/index.js';
import { RestartCallout } from './settings/RestartCallout.js';
import './run/run.css';

export function ProjectVariables({
  projectId,
  canWrite,
}: {
  projectId: string;
  canWrite: boolean;
}): React.JSX.Element {
  const listed = useResource((signal) => fetchVariables(projectId, signal), [projectId]);
  const variables = listed.data?.variables ?? [];

  const [key, setKey] = useState('');
  const [value, setValue] = useState('');
  const [editing, setEditing] = useState<string | undefined>();
  const [fieldErrors, setFieldErrors] = useState<{
    key?: string | undefined;
    value?: string | undefined;
  }>({});
  const [removing, setRemoving] = useState<ProjectVariable | undefined>();
  const [importing, setImporting] = useState(false);
  const nameInput = useRef<HTMLInputElement>(null);

  const save = useAction(async () => {
    await setVariable(projectId, { key, value });
  });
  const remove = useAction(async (variable: ProjectVariable) => {
    await deleteVariable(projectId, variable.key);
  });

  const resetForm = (): void => {
    setKey('');
    setValue('');
    setEditing(undefined);
    setFieldErrors({});
    save.reset();
  };

  const onSubmit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setFieldErrors({});
    const outcome = await save.run();
    if (outcome.ok) {
      toast({ tone: 'success', title: editing ? `Saved ${key}` : `Added ${key}` });
      resetForm();
      listed.reload();
      return;
    }
    const { fields } = fieldErrorsFrom(outcome.error);
    if (fields.key || fields.value) {
      setFieldErrors({
        ...(fields.key ? { key: fields.key } : {}),
        ...(fields.value ? { value: fields.value } : {}),
      });
      save.reset();
    }
  };

  const edit = (variable: ProjectVariable): void => {
    setKey(variable.key);
    setValue(variable.value);
    setEditing(variable.key);
    setFieldErrors({});
    save.reset();
    nameInput.current?.focus();
  };

  const focusForm = (): void => nameInput.current?.focus();

  const generalError =
    save.error && !fieldErrors.key && !fieldErrors.value
      ? save.error instanceof ApiError
        ? save.error.message
        : 'The variable could not be saved.'
      : undefined;

  return (
    <section className="run-section" aria-labelledby="variables-heading">
      <SectionHeader
        title={<span id="variables-heading">Environment variables</span>}
        icon={SlidersHorizontal}
        description="Configuration the app is given when the environment starts. Anyone who can edit the project can read these; anything that would be damaging to read belongs in Secrets instead."
        action={
          <span className="run-section__header-side">
            {listed.data ? (
              <span className="run-section__meta">
                {variables.length} of {listed.data.limit}
              </span>
            ) : null}
            {canWrite ? (
              <Button size="sm" icon={UploadSimple} onClick={() => setImporting(true)}>
                Import .env
              </Button>
            ) : null}
          </span>
        }
      />

      {listed.data?.restartRequired ? (
        <RestartCallout projectId={projectId}>
          The environment is running with the values it started with. Restart it for changes here to
          take effect.
        </RestartCallout>
      ) : null}

      {canWrite ? (
        <form className="run-form" onSubmit={(event) => void onSubmit(event)} noValidate>
          {editing ? (
            <p className="run-form__editing" role="status">
              Editing <code className="run-value">{editing}</code>. The name cannot be changed;
              remove the variable to use another.
            </p>
          ) : null}
          <div className="run-form__fields">
            <Field id="variable-key" label="Variable name" error={fieldErrors.key}>
              <Input
                ref={nameInput}
                id="variable-key"
                name="variable-key"
                value={key}
                onChange={(event) => {
                  setKey(event.target.value.toUpperCase());
                  if (fieldErrors.key)
                    setFieldErrors((current) => ({ ...current, key: undefined }));
                }}
                placeholder="LOG_LEVEL"
                autoComplete="off"
                spellCheck={false}
                mono
                readOnly={editing !== undefined}
                invalid={Boolean(fieldErrors.key)}
                aria-describedby={fieldErrors.key ? 'variable-key-error' : undefined}
                required
              />
            </Field>
            <Field
              id="variable-value"
              label="Variable value"
              value={value}
              onChange={(event) => {
                setValue(event.target.value);
                if (fieldErrors.value) {
                  setFieldErrors((current) => ({ ...current, value: undefined }));
                }
              }}
              placeholder="debug"
              autoComplete="off"
              mono
              error={fieldErrors.value}
            />
          </div>
          {generalError ? <Callout tone="danger" title={generalError} /> : null}
          <div className="run-form__actions">
            <Button type="submit" loading={save.busy}>
              Save variable
            </Button>
            {editing ? (
              <Button variant="ghost" onClick={resetForm}>
                Cancel
              </Button>
            ) : null}
          </div>
        </form>
      ) : null}

      <Table<ProjectVariable>
        caption="Environment variables"
        density="dense"
        columns={[
          {
            key: 'name',
            header: 'Name',
            mono: true,
            cell: (variable) => variable.key,
          },
          {
            key: 'value',
            header: 'Value',
            cell: (variable) =>
              variable.value === '' ? (
                <em className="run-value run-value--empty">empty</em>
              ) : (
                <code className="run-value">{variable.value}</code>
              ),
          },
          {
            key: 'updated',
            header: 'Updated',
            width: '120px',
            cell: (variable) => <RelativeTime value={variable.updatedAt} />,
          },
        ]}
        rows={variables}
        rowKey={(variable) => variable.key}
        rowName={(variable) => variable.key}
        {...(canWrite
          ? {
              rowActions: (variable: ProjectVariable) => [
                { label: 'Edit', icon: PencilSimple, onSelect: () => edit(variable) },
                {
                  label: 'Remove',
                  icon: Trash,
                  tone: 'danger' as const,
                  onSelect: () => setRemoving(variable),
                },
              ],
            }
          : {})}
        loading={listed.status === 'loading'}
        {...(listed.status === 'error'
          ? {
              error:
                listed.error instanceof ApiError
                  ? listed.error.message
                  : 'The environment variables could not be loaded.',
              onRetry: listed.reload,
            }
          : {})}
        empty={{
          icon: SlidersHorizontal,
          title: 'No environment variables yet.',
          body: 'Values here are visible to editors; put anything sensitive in Secrets.',
          ...(canWrite
            ? {
                action: (
                  <Button variant="primary" onClick={focusForm}>
                    Add variable
                  </Button>
                ),
              }
            : {}),
        }}
      />

      <ConfirmDialog
        open={removing !== undefined}
        onOpenChange={(open) => {
          if (!open) setRemoving(undefined);
        }}
        tone="danger"
        title={`Remove ${removing?.key ?? 'this variable'}?`}
        body={`The app will no longer be given ${removing?.key ?? 'it'} the next time the environment starts.`}
        confirmLabel={`Remove ${removing?.key ?? 'variable'}`}
        onConfirm={async () => {
          if (!removing) return;
          const outcome = await remove.run(removing);
          if (!outcome.ok) {
            throw new Error(
              outcome.error instanceof ApiError
                ? outcome.error.message
                : 'The variable could not be removed.',
            );
          }
          toast({ tone: 'success', title: `Removed ${removing.key}` });
          if (editing === removing.key) resetForm();
          listed.reload();
        }}
      />

      {canWrite ? (
        <ImportDialog
          projectId={projectId}
          open={importing}
          onOpenChange={setImporting}
          onImported={listed.reload}
        />
      ) : null}
    </section>
  );
}

function ImportDialog({
  projectId,
  open,
  onOpenChange,
  onImported,
}: {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported: () => void;
}): React.JSX.Element {
  const [text, setText] = useState('');
  const [asSecrets, setAsSecrets] = useState(true);
  const [result, setResult] = useState<ImportEnvironmentResponse | undefined>();
  const run = useAction(() =>
    importEnvironment(projectId, { text, as: asSecrets ? 'secrets' : 'variables' }),
  );

  const preview = parseDotenv(text);
  const close = (): void => {
    onOpenChange(false);
    setText('');
    setAsSecrets(true);
    setResult(undefined);
    run.reset();
  };

  const submit = async (): Promise<void> => {
    const outcome = await run.run();
    if (!outcome.ok) return;
    onImported();
    if (outcome.value.refused.length === 0) {
      toast({
        tone: 'success',
        title: `Imported ${outcome.value.applied.length} ${asSecrets ? 'secrets' : 'variables'}`,
      });
      close();
      return;
    }
    setResult(outcome.value);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
      title="Import from a .env file"
      description="Paste the file. Each KEY=value line becomes one entry; comments and blank lines are skipped."
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={run.busy}
            onClick={() => void submit()}
            {...(preview.entries.length === 0
              ? { disabledReason: 'Paste at least one KEY=value line first' }
              : {})}
          >
            {preview.entries.length === 0 ? 'Import' : `Import ${preview.entries.length}`}
          </Button>
        </>
      }
    >
      <div className="run-import">
        <Field id="import-env-text" label="Contents of the .env file">
          <Textarea
            id="import-env-text"
            name="import-env-text"
            rows={8}
            mono
            value={text}
            onChange={(event) => {
              setText(event.target.value);
              setResult(undefined);
            }}
            spellCheck={false}
            placeholder={'API_TOKEN=sk-live-...\nLOG_LEVEL=debug'}
          />
        </Field>
        <Checkbox
          label="Treat as secrets"
          description="Secrets are encrypted and never shown again. Untick to store them as variables, which appear on this page."
          checked={asSecrets}
          onCheckedChange={(checked) => setAsSecrets(checked)}
        />
        {text.trim() !== '' ? (
          <p className="run-import__summary">
            {preview.entries.length === 0
              ? 'Nothing to import yet.'
              : `${preview.entries.length} to set: ${preview.entries.map((entry) => entry.key).join(', ')}.`}
            {preview.problems.length > 0
              ? ` ${preview.problems.length} ${preview.problems.length === 1 ? 'line' : 'lines'} will be skipped.`
              : ''}
          </p>
        ) : null}
        {run.error ? (
          <Callout
            tone="danger"
            title={
              run.error instanceof ApiError ? run.error.message : 'The file could not be imported.'
            }
          />
        ) : null}
        {result ? (
          <Callout
            tone="warn"
            title={`${result.applied.length} set, ${result.refused.length} refused`}
          >
            <ul className="run-list">
              {result.refused.map((refused) => (
                <li key={refused.line}>
                  Line {refused.line}
                  {refused.key ? ` (${refused.key})` : ''}: {refused.reason}
                </li>
              ))}
            </ul>
          </Callout>
        ) : null}
      </div>
    </Dialog>
  );
}
