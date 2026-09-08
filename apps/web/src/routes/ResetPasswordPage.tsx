import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { PASSWORD_MIN_LENGTH } from '@platform/shared';
import { ApiError } from '../lib/api-client.js';
import { fieldErrorsFrom, type FieldErrors } from '../lib/form-errors.js';
import { completePasswordReset } from '../lib/verification-api.js';
import '../styles/form.css';

/**
 * Choosing a new password from a link.
 *
 * Unlike the verification page, this does **not** act on arrival: the link only
 * proves somebody reached the inbox, and what happens next changes the
 * credential on the account. A person has to type the new password, which is
 * the point at which they are deciding rather than merely clicking.
 *
 * Using the link signs every session out, including one open in this browser.
 * Saying so before they submit rather than afterwards is the difference between
 * a consequence and a surprise.
 */
export function ResetPasswordPage(): React.JSX.Element {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const token = params.get('token') ?? '';

  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});

  if (!token) {
    return (
      <div className="auth-card">
        <h1>Choose a new password</h1>
        <p className="form-error">That link is missing its code. Ask for a new one.</p>
        <p className="auth-switch">
          <Link to="/forgot-password">Send me another link</Link>
        </p>
      </div>
    );
  }

  return (
    <div className="auth-card">
      <h1>Choose a new password</h1>
      <p className="auth-subtitle">
        Using this link signs you out everywhere, including here. You will sign in again with the
        password you choose now.
      </p>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          setBusy(true);
          setError(undefined);
          setFieldErrors({});

          completePasswordReset({ token, password })
            .then(() => {
              // Straight to sign-in: the session this browser had, if any, has
              // just been ended along with all the others.
              navigate('/login', { replace: true });
            })
            .catch((cause: unknown) => {
              const { fields, message } = fieldErrorsFrom(cause);
              setFieldErrors(fields);
              setError(
                message ??
                  (cause instanceof ApiError
                    ? cause.message
                    : 'The password could not be changed.'),
              );
              setBusy(false);
            });
        }}
      >
        <div className="field">
          <label htmlFor="new-password">New password</label>
          <input
            id="new-password"
            className={fieldErrors.password ? 'input input--error' : 'input'}
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            minLength={PASSWORD_MIN_LENGTH}
            required
          />
          {fieldErrors.password ? (
            <p className="field-error">{fieldErrors.password}</p>
          ) : (
            <p className="field-hint">At least {PASSWORD_MIN_LENGTH} characters.</p>
          )}
        </div>

        {error && <p className="form-error">{error}</p>}

        <button type="submit" className="button-primary" disabled={busy}>
          {busy ? 'Saving…' : 'Set my new password'}
        </button>
      </form>

      <p className="auth-switch">
        <Link to="/login">Back to sign in</Link>
      </p>
    </div>
  );
}
