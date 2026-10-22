import { useEffect, useState, type FormEvent } from 'react';
import { Field } from '../../components/Field.js';
import { deleteAccount } from '../../lib/account-api.js';
import { ApiError } from '../../lib/api-client.js';
import { useAuth } from '../../lib/auth-context.js';
import { useAction } from '../../lib/use-action.js';
import { Warning } from '../../ui/icons.js';
import { Button, Callout, Card, Dialog, SectionHeader } from '../../ui/index.js';

export function CloseAccountSection(): React.JSX.Element {
  const { user, refresh } = useAuth();
  const [open, setOpen] = useState(false);

  return (
    <section className="account-section" aria-labelledby="close-heading">
      <SectionHeader id="close-heading" title="Close account" />
      <Card tone="danger" className="account-card">
        <h3 className="account-card__title">
          <Warning size={16} aria-hidden="true" />
          Close this account
        </h3>
        <p className="account-card__text">
          Every project you own is deleted, along with its files, history, snapshots, database and
          anything deployed from it. People you shared those projects with lose access. Projects
          owned by somebody else are not affected. This cannot be undone.
        </p>
        <div className="account-card__actions">
          <Button variant="danger" onClick={() => setOpen(true)}>
            Close account
          </Button>
        </div>
      </Card>
      <CloseAccountDialog
        open={open}
        onOpenChange={setOpen}
        username={user?.username}
        onDeleted={refresh}
      />
    </section>
  );
}

function CloseAccountDialog({
  open,
  onOpenChange,
  username,
  onDeleted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  username: string | undefined;
  onDeleted: () => Promise<void>;
}): React.JSX.Element {
  const [password, setPassword] = useState('');
  const [confirmUsername, setConfirmUsername] = useState('');
  const remove = useAction(() => deleteAccount({ password, confirmUsername }));

  useEffect(() => {
    if (!open) {
      setPassword('');
      setConfirmUsername('');
      remove.reset();
    }
  }, [open]);

  const matches =
    username !== undefined && confirmUsername.trim().toLowerCase() === username.toLowerCase();

  const onSubmit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!matches) return;
    const outcome = await remove.run();
    if (!outcome.ok) return;
    await onDeleted();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (remove.busy) return;
        onOpenChange(next);
      }}
      title="Close this account permanently?"
      description="Everything you own on this platform is deleted. This cannot be undone."
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={remove.busy}>
            Cancel
          </Button>
          <Button
            type="submit"
            form="close-account"
            variant="danger"
            loading={remove.busy}
            {...(password === ''
              ? { disabledReason: 'Enter your password' }
              : matches
                ? {}
                : { disabledReason: `Type ${username ?? 'your username'} to confirm` })}
          >
            Close this account permanently
          </Button>
        </>
      }
    >
      <form
        id="close-account"
        className="account-form"
        onSubmit={(event) => void onSubmit(event)}
        noValidate
      >
        <Field
          id="close-account-password"
          label="Your password"
          as="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => {
            setPassword(event.target.value);
            if (remove.error) remove.reset();
          }}
          required
          autoFocus
        />
        <Field
          id="close-account-username"
          label={`Type ${username ?? 'your username'} to confirm`}
          value={confirmUsername}
          onChange={(event) => {
            setConfirmUsername(event.target.value);
            if (remove.error) remove.reset();
          }}
          autoComplete="off"
          mono
          required
        />
        {remove.error ? (
          <Callout
            tone="danger"
            title={
              remove.error instanceof ApiError
                ? remove.error.message
                : 'The account could not be closed.'
            }
          >
            Try again, or cancel.
          </Callout>
        ) : null}
      </form>
    </Dialog>
  );
}
