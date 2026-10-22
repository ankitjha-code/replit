import { useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { PASSWORD_MIN_LENGTH, passwordSchema } from '@platform/shared';
import { ApiError } from '../lib/api-client.js';
import { useAuth } from '../lib/auth-context.js';
import { fieldErrorsFrom } from '../lib/form-errors.js';
import { completePasswordReset } from '../lib/verification-api.js';
import { Button, Callout, EmptyState } from '../ui/index.js';
import { Lock } from '../ui/icons.js';
import { AuthCard } from './auth/AuthCard.js';
import { PasswordField } from './auth/PasswordField.js';

const INCOMPLETE_LINK =
  'This link is incomplete. Open the newest message from the platform and use the whole link, or request a new one.';

export function ResetPasswordPage(): React.JSX.Element {
  const [params] = useSearchParams();
  const { refresh } = useAuth();
  const token = params.get('token') ?? '';

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [passwordError, setPasswordError] = useState<string | undefined>();
  const [confirmError, setConfirmError] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [deadLink, setDeadLink] = useState<string | undefined>(token ? undefined : INCOMPLETE_LINK);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError(undefined);

    const parsed = passwordSchema.safeParse(password);
    const mismatch = confirm !== password;
    setPasswordError(parsed.success ? undefined : parsed.error.issues[0]?.message);
    setConfirmError(mismatch ? 'The two passwords do not match' : undefined);
    if (!parsed.success || mismatch) return;

    setBusy(true);
    try {
      await completePasswordReset({ token, password });
      await refresh().catch(() => undefined);
      setDone(true);
    } catch (cause) {
      const mapped = fieldErrorsFrom(cause);
      if (mapped.fields.password) {
        setPasswordError(mapped.fields.password);
      } else if (
        cause instanceof ApiError &&
        (cause.code === 'VALIDATION_FAILED' || cause.code === 'NOT_FOUND')
      ) {
        setDeadLink(cause.message);
      } else {
        setError(mapped.message ?? 'The password could not be changed.');
      }
      setBusy(false);
    }
  }

  if (deadLink) {
    return (
      <AuthCard
        footer={
          <p>
            <Link to="/login">Back to sign in</Link>
          </p>
        }
      >
        <EmptyState
          size="page"
          icon={Lock}
          title={
            <span role="heading" aria-level={1}>
              This link no longer works
            </span>
          }
          body={<span role="alert">{deadLink}</span>}
          action={
            <Button variant="primary" size="lg" asChild>
              <Link to="/forgot-password">Request a new link</Link>
            </Button>
          }
        />
      </AuthCard>
    );
  }

  if (done) {
    return (
      <AuthCard
        title="Password changed"
        description="You have been signed out everywhere, including here. Sign in with the password you just chose."
      >
        <p className="visually-hidden" role="status">
          Password changed.
        </p>
        <Button variant="primary" size="lg" className="auth-form__submit" asChild>
          <Link to="/login">Sign in</Link>
        </Button>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title="Choose a new password"
      description="Using this link signs you out everywhere, including here. You will sign in again with the password you choose now."
      footer={
        <p>
          <Link to="/login">Back to sign in</Link>
        </p>
      }
    >
      <form className="auth-form" onSubmit={submit} noValidate>
        <PasswordField
          id="new-password"
          label="New password"
          autoComplete="new-password"
          value={password}
          onChange={(value) => {
            setPassword(value);
            setPasswordError(undefined);
          }}
          error={passwordError}
          hint={`At least ${PASSWORD_MIN_LENGTH} characters. A passphrase works well.`}
          autoFocus
        />
        <PasswordField
          id="confirm-password"
          label="Confirm password"
          autoComplete="new-password"
          value={confirm}
          onChange={(value) => {
            setConfirm(value);
            setConfirmError(undefined);
          }}
          error={confirmError}
        />

        {error ? <Callout tone="danger">{error}</Callout> : null}

        <Button
          type="submit"
          variant="primary"
          size="lg"
          className="auth-form__submit"
          loading={busy}
          loadingLabel="Saving your new password"
        >
          Set my new password
        </Button>
      </form>
    </AuthCard>
  );
}
