import { useState, type FormEvent } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { loginRequestSchema } from '@platform/shared';
import { Field } from '../components/Field.js';
import { useAuth } from '../lib/auth-context.js';
import { fieldErrorsFrom, type FieldErrors } from '../lib/form-errors.js';
import '../styles/form.css';

export function LoginPage(): React.JSX.Element {
  const { status, signIn, completeTwoFactor } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [values, setValues] = useState({ identifier: '', password: '' });
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | undefined>();
  const [submitting, setSubmitting] = useState(false);
  /** Set when the password was right and a second factor is owed. */
  const [challenge, setChallenge] = useState<string | undefined>();
  const [code, setCode] = useState('');

  if (status === 'authenticated') return <Navigate to="/" replace />;

  /** Where the user was heading before being asked to sign in. */
  const returnTo = (location.state as { from?: string } | null)?.from ?? '/';

  const set = (field: keyof typeof values) => (event: { target: { value: string } }) => {
    setValues((current) => ({ ...current, [field]: event.target.value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
  };

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setFormError(undefined);

    const parsed = loginRequestSchema.safeParse(values);
    if (!parsed.success) {
      const fields: FieldErrors = {};
      for (const issue of parsed.error.issues) {
        const path = issue.path.map(String).join('.');
        if (path && !(path in fields)) fields[path] = issue.message;
      }
      setErrors(fields);
      return;
    }

    setSubmitting(true);
    try {
      const answer = await signIn(parsed.data);
      if ('challenge' in answer) {
        setChallenge(answer.challenge);
        setSubmitting(false);
        return;
      }
      navigate(returnTo, { replace: true });
    } catch (error) {
      const mapped = fieldErrorsFrom(error);
      setErrors(mapped.fields);
      // A rejected sign-in is shown as one message above the form, never
      // against a field. Marking the password field would say the identifier
      // was right, which is exactly what the server declined to reveal.
      setFormError(mapped.message ?? 'Incorrect email, username or password');
      setSubmitting(false);
    }
  }

  /*
   * The second step, for an account with a second factor.
   *
   * The password has been accepted and no session exists yet. One field: the six
   * digits from the app, or a recovery code — the server tells them apart, so a
   * person who has lost their phone does not have to find a different form.
   */
  if (challenge) {
    return (
      <div className="auth-card">
        <h1>One more step</h1>
        <p className="auth-subtitle">
          Enter the code from your authenticator app, or a recovery code.
        </p>

        <form
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            setSubmitting(true);
            setFormError(undefined);
            completeTwoFactor(challenge, code.trim())
              .then(() => navigate(returnTo, { replace: true }))
              .catch((error: unknown) => {
                setFormError(
                  fieldErrorsFrom(error).message ?? 'That code is not right. Sign in again.',
                );
                setSubmitting(false);
              });
          }}
        >
          <Field
            id="code"
            label="Code"
            autoComplete="one-time-code"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            autoFocus
          />

          {formError && (
            <p className="form-error" role="alert">
              {formError}
            </p>
          )}

          <button
            type="submit"
            className="button-primary"
            disabled={submitting || code.trim() === ''}
          >
            {submitting ? 'Checking…' : 'Continue'}
          </button>
        </form>

        <p className="auth-switch">
          <button
            type="button"
            className="button-quiet"
            onClick={() => {
              setChallenge(undefined);
              setCode('');
              setFormError(undefined);
            }}
          >
            Start again
          </button>
        </p>
      </div>
    );
  }

  return (
    <div className="auth-card">
      <h1>Sign in</h1>
      <p className="auth-subtitle">Welcome back.</p>

      <form onSubmit={submit} noValidate>
        <Field
          id="identifier"
          label="Email or username"
          autoComplete="username"
          value={values.identifier}
          onChange={set('identifier')}
          error={errors.identifier}
          autoFocus
        />
        <Field
          id="password"
          label="Password"
          type="password"
          autoComplete="current-password"
          value={values.password}
          onChange={set('password')}
          error={errors.password}
        />

        {formError && (
          <p className="form-error" role="alert">
            {formError}
          </p>
        )}

        <button type="submit" className="button-primary" disabled={submitting}>
          {submitting ? 'Signing in…' : 'Sign in'}
        </button>
      </form>

      <p className="auth-switch">
        {/*
         * Below the form rather than beside the password field.
         *
         * Somebody reaches for this after a failed attempt, not before one, and
         * a link that competes with the field it is about invites the click
         * instead of the typing.
         */}
        <Link to="/forgot-password">Forgotten your password?</Link>
      </p>
      <p className="auth-switch">
        No account yet? <Link to="/register">Create one</Link>
      </p>
    </div>
  );
}
