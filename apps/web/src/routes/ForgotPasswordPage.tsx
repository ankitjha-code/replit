import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { emailSchema } from '@platform/shared';
import { Field } from '../components/Field.js';
import { fieldErrorsFrom } from '../lib/form-errors.js';
import { useResource } from '../lib/use-resource.js';
import { fetchMailAvailability, requestPasswordReset } from '../lib/verification-api.js';
import { Button, Callout } from '../ui/index.js';
import { AuthCard } from './auth/AuthCard.js';
import { useCooldown } from './auth/use-cooldown.js';

/** How long "Send another link" waits between presses; the server retires the previous link anyway. */
export const RESEND_COOLDOWN_MS = 60_000;

/**
 * Asking for a reset link.
 *
 * The answer is the same whatever happened: an address with an account, one
 * without, too many requests already. All of them show the same message,
 * because the difference between them is precisely the fact worth hiding: an
 * endpoint that answered differently would be a way to learn who has an
 * account here, which is a list of who to phish.
 *
 * The one thing that can be said up front is whether this installation can
 * send mail at all, which public readiness reports.
 */
export function ForgotPasswordPage(): React.JSX.Element {
  const [email, setEmail] = useState('');
  const [fieldError, setFieldError] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [resent, setResent] = useState(false);
  const cooldown = useCooldown(RESEND_COOLDOWN_MS);
  const mail = useResource((signal) => fetchMailAvailability(signal), []);

  async function send(): Promise<boolean> {
    setBusy(true);
    setError(undefined);
    try {
      await requestPasswordReset(email.trim());
      return true;
    } catch (cause) {
      // Only a transport failure or a limiter can reach here: the server
      // accepts every well-formed request, and says nothing about the address.
      const mapped = fieldErrorsFrom(cause);
      if (mapped.fields.email) setFieldError(mapped.fields.email);
      else setError(mapped.message ?? 'The request could not be sent.');
      return false;
    } finally {
      setBusy(false);
    }
  }

  /** The first request, or its Retry: either way the sent screen follows success. */
  async function sendFirst(): Promise<void> {
    if (await send()) {
      setSent(true);
      cooldown.start();
    }
  }

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    const parsed = emailSchema.safeParse(email);
    if (!parsed.success) {
      setFieldError('Enter a valid email address');
      return;
    }
    setFieldError(undefined);
    await sendFirst();
  }

  async function resend(): Promise<void> {
    setResent(false);
    if (await send()) {
      setResent(true);
      cooldown.start();
    }
  }

  if (sent) {
    return (
      <AuthCard
        title="Check your email"
        description={`If there is an account for ${email.trim()}, a link to choose a new password is on its way. It stops working shortly, so open it when it arrives.`}
        footer={
          <p>
            <Link to="/login">Back to sign in</Link>
          </p>
        }
      >
        <p className="auth-status">
          Nothing arrived? Check the address you typed, and look in your spam folder. Asking again
          replaces the previous link.
        </p>
        {error ? (
          <Callout
            tone="danger"
            action={
              <Button variant="secondary" size="sm" onClick={() => void resend()}>
                Retry
              </Button>
            }
          >
            {error}
          </Callout>
        ) : null}
        <div className="auth-actions">
          <Button
            variant="secondary"
            loading={busy}
            loadingLabel="Sending"
            onClick={() => void resend()}
            {...(cooldown.remaining > 0
              ? { disabledReason: `You can ask again in ${cooldown.remaining}s` }
              : {})}
          >
            Send another link
          </Button>
        </div>
        <p className="auth-status" role="status">
          {resent ? 'Another link is on its way.' : ''}
        </p>
      </AuthCard>
    );
  }

  const mailOff = mail.data?.configured === false;

  return (
    <AuthCard
      title="Forgot your password?"
      description="Type the address on your account and the platform will send a link to choose a new password."
      footer={
        <p>
          <Link to="/login">Back to sign in</Link>
        </p>
      }
    >
      {mailOff ? (
        <Callout tone="info" title="This installation cannot send email">
          A reset link cannot reach you here. Ask whoever runs this installation to reset your
          password.
        </Callout>
      ) : (
        <form className="auth-form" onSubmit={submit} noValidate>
          {mail.data && !mail.data.up ? (
            <Callout tone="warn">
              The mail server is not answering right now. If no message arrives, try again in a few
              minutes.
            </Callout>
          ) : null}

          <Field
            id="reset-email"
            label="Email address"
            type="email"
            autoComplete="email"
            inputMode="email"
            value={email}
            onChange={(event) => {
              setEmail(event.target.value);
              setFieldError(undefined);
            }}
            error={fieldError}
            autoFocus
          />

          {error ? (
            <Callout
              tone="danger"
              action={
                <Button variant="secondary" size="sm" onClick={() => void sendFirst()}>
                  Retry
                </Button>
              }
            >
              {error}
            </Callout>
          ) : null}

          <Button
            type="submit"
            variant="primary"
            size="lg"
            className="auth-form__submit"
            loading={busy}
            loadingLabel="Sending"
          >
            Send reset link
          </Button>
        </form>
      )}
    </AuthCard>
  );
}
