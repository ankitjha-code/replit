import { useRef, useState, type FormEvent } from 'react';
import type { SecretSummary } from '@platform/shared';
import { Field } from '../components/Field.js';
import { ApiError } from '../lib/api-client.js';
import { fieldErrorsFrom } from '../lib/form-errors.js';
import { deleteSecret, fetchSecrets, setSecret } from '../lib/project-storage-api.js';
import { useAction } from '../lib/use-action.js';
import { useResource } from '../lib/use-resource.js';
import { Key, Trash } from '../ui/icons.js';
import {
  Button,
  Callout,
  ConfirmDialog,
  EmptyState,
  Input,
  ListRow,
  RelativeTime,
  RowActions,
  SecretValue,
  SectionHeader,
  Skeleton,
  toast,
} from '../ui/index.js';
import { RestartCallout } from './settings/RestartCallout.js';
import './run/run.css';

export function ProjectSecrets({ projectId }: { projectId: string }): React.JSX.Element {
  const listed = useResource((signal) => fetchSecrets(projectId, signal), [projectId]);
  const secrets = listed.data?.secrets ?? [];
  const unavailable = listed.data?.unavailableReason ?? null;

  const [key, setKey] = useState('');
  const [value, setValue] = useState('');
  const [fieldErrors, setFieldErrors] = useState<{
    key?: string | undefined;
    value?: string | undefined;
  }>({});
  const [removing, setRemoving] = useState<SecretSummary | undefined>();
  const [changed, setChanged] = useState(false);
  const nameInput = useRef<HTMLInputElement>(null);

  const save = useAction(async () => {
    await setSecret(projectId, { key, value });
  });
  const remove = useAction(async (secret: SecretSummary) => {
    await deleteSecret(projectId, secret.key);
  });

  const onSubmit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setFieldErrors({});
    const outcome = await save.run();
    if (outcome.ok) {
      toast({ tone: 'success', title: `Saved ${key}` });
      setKey('');
      setValue('');
      setChanged(true);
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

  const generalError =
    save.error && !fieldErrors.key && !fieldErrors.value
      ? save.error instanceof ApiError
        ? save.error.message
        : 'The secret could not be saved.'
      : undefined;

  return (
    <section className="run-section" aria-labelledby="secrets-heading">
      <SectionHeader
        title={<span id="secrets-heading">Secrets</span>}
        icon={Key}
        description="Encrypted, and given to the app when the environment starts. Values cannot be read back, by anyone; replace one you have forgotten."
        action={
          listed.data && !unavailable ? (
            <span className="run-section__meta">
              {secrets.length} of {listed.data.limit}
            </span>
          ) : undefined
        }
      />

      {unavailable ? <Callout tone="info" title={unavailable} /> : null}

      {changed ? (
        <RestartCallout projectId={projectId}>
          Secrets are given to the app when the environment starts. Restart it for changes here to
          take effect.
        </RestartCallout>
      ) : null}

      {!unavailable && listed.status !== 'loading' ? (
        <form className="run-form" onSubmit={(event) => void onSubmit(event)} noValidate>
          <div className="run-form__fields">
            <Field
              id="secret-key"
              label="Name"
              error={fieldErrors.key}
              hint="Letters, digits and underscores, starting with a letter."
            >
              <Input
                ref={nameInput}
                id="secret-key"
                name="secret-key"
                value={key}
                onChange={(event) => {
                  setKey(event.target.value.toUpperCase());
                  if (fieldErrors.key)
                    setFieldErrors((current) => ({ ...current, key: undefined }));
                }}
                placeholder="API_TOKEN"
                autoComplete="off"
                spellCheck={false}
                mono
                invalid={Boolean(fieldErrors.key)}
                aria-describedby={fieldErrors.key ? 'secret-key-error' : 'secret-key-hint'}
                required
              />
            </Field>
            <Field
              id="secret-value"
              label="Value"
              type="password"
              revealable
              value={value}
              onChange={(event) => {
                setValue(event.target.value);
                if (fieldErrors.value) {
                  setFieldErrors((current) => ({ ...current, value: undefined }));
                }
              }}
              autoComplete="off"
              mono
              required
              error={fieldErrors.value}
            />
          </div>
          {generalError ? <Callout tone="danger" title={generalError} /> : null}
          <div className="run-form__actions">
            <Button type="submit" loading={save.busy}>
              Save secret
            </Button>
          </div>
        </form>
      ) : null}

      {listed.status === 'loading' ? (
        <div className="run-list__skeleton" aria-busy="true">
          <Skeleton shape="row" />
          <Skeleton shape="row" />
        </div>
      ) : listed.status === 'error' ? (
        <Callout
          tone="danger"
          title={
            listed.error instanceof ApiError
              ? listed.error.message
              : 'The secrets could not be loaded.'
          }
          action={
            <Button size="sm" onClick={listed.reload}>
              Retry
            </Button>
          }
        />
      ) : secrets.length === 0 && !unavailable ? (
        <EmptyState
          icon={Key}
          title="No secrets yet."
          body="Values are encrypted before they are stored, and only the app ever sees them."
          action={
            <Button variant="primary" onClick={() => nameInput.current?.focus()}>
              Add secret
            </Button>
          }
        />
      ) : secrets.length > 0 ? (
        <ul className="run-list">
          {secrets.map((secret) => (
            <ListRow
              key={secret.key}
              title={<code className="run-value">{secret.key}</code>}
              description={<SecretValue value="" revealable={false} />}
              meta={<RelativeTime value={secret.updatedAt} prefix="Set" />}
              actions={
                <RowActions
                  objectName={secret.key}
                  items={[
                    {
                      label: 'Remove',
                      icon: Trash,
                      tone: 'danger',
                      onSelect: () => setRemoving(secret),
                    },
                  ]}
                />
              }
            />
          ))}
        </ul>
      ) : null}

      <ConfirmDialog
        open={removing !== undefined}
        onOpenChange={(open) => {
          if (!open) setRemoving(undefined);
        }}
        tone="danger"
        title={`Remove ${removing?.key ?? 'this secret'}?`}
        body="This value cannot be recovered. The app will no longer be given it the next time the environment starts."
        confirmLabel={`Remove ${removing?.key ?? 'secret'}`}
        onConfirm={async () => {
          if (!removing) return;
          const outcome = await remove.run(removing);
          if (!outcome.ok) {
            throw new Error(
              outcome.error instanceof ApiError
                ? outcome.error.message
                : 'The secret could not be removed.',
            );
          }
          toast({ tone: 'success', title: `Removed ${removing.key}` });
          setChanged(true);
          listed.reload();
        }}
      />
    </section>
  );
}
