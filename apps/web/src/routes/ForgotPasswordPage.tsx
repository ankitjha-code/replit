import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../lib/api-client.js';
import { requestPasswordReset } from '../lib/verification-api.js';
import '../styles/form.css';

/**
 * Asking for a reset link.
 *
 * The answer is the same whatever happened: an address with an account, one
 * without, a mail server that is down, too many requests already. All of them
 * show the message below, because the difference between them is precisely the
 * fact worth hiding — an endpoint that answered differently would be a way to
 * learn who has an account here, which is a list of who to phish.
 *
 * The cost is real. Somebody who mistypes their address is told the same as
 * somebody who did not, and only the message that does or does not arrive tells
 * them apart. The wording below tries to make that failure recoverable by
 * naming it rather than by promising delivery.
 */
export function ForgotPasswordPage(): React.JSX.Element {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | undefined>();

  if (sent) {
    return (
      <div className="auth-card">
        <h1>Check your email</h1>
        <p className="auth-subtitle">
          If there is an account for {email}, a link to choose a new password is on its way. It
          stops working shortly, so open it when it arrives.
        </p>
        <p className="auth-note">
          Nothing arrived? Check the address you typed, and look in your spam folder. Asking again
          replaces the previous link.
        </p>
        <p className="auth-switch">
          <Link to="/login">Back to sign in</Link>
        </p>
      </div>
    );
  }

  return (
    <div className="auth-card">
      <h1>Forgotten password</h1>
      <p className="auth-subtitle">
        Type the address on your account and the platform will send a link to choose a new password.
      </p>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          setBusy(true);
          setError(undefined);

          requestPasswordReset(email)
            .then(() => setSent(true))
            .catch((cause: unknown) => {
              /*
               * Only a transport failure can reach here.
               *
               * The server accepts every well-formed request, so an error means
               * the request did not arrive — which is worth showing, and says
               * nothing about the address.
               */
              setError(
                cause instanceof ApiError ? cause.message : 'The request could not be sent.',
              );
            })
            .finally(() => setBusy(false));
        }}
      >
        <div className="field">
          <label htmlFor="reset-email">Email address</label>
          <input
            id="reset-email"
            className="input"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />
        </div>

        {error && <p className="form-error">{error}</p>}

        <button type="submit" className="button-primary" disabled={busy}>
          {busy ? 'Sending…' : 'Send me a link'}
        </button>
      </form>

      <p className="auth-switch">
        <Link to="/login">Back to sign in</Link>
      </p>
    </div>
  );
}
