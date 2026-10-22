import { useState, type FormEvent } from 'react';
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { loginRequestSchema } from '@platform/shared';
import { Field } from '../components/Field.js';
import { TWO_FACTOR_CHALLENGE_TTL_MS } from '../lib/auth-api.js';
import { useAuth } from '../lib/auth-context.js';
import { fieldErrorsFrom, type FieldErrors } from '../lib/form-errors.js';
import { Button, Callout } from '../ui/index.js';
import { AuthCard } from './auth/AuthCard.js';
import { PasswordField } from './auth/PasswordField.js';
import { resolveReturnTo } from './auth/return-to.js';
import { TwoFactorStep } from './auth/TwoFactorStep.js';

export function LoginPage(): React.JSX.Element {
  const { status, reason, signIn, completeTwoFactor } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();

  const [values, setValues] = useState({ identifier: '', password: '' });
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | undefined>();
  const [submitting, setSubmitting] = useState(false);
  /** Set when the password was right and a second factor is owed. */
  const [challenge, setChallenge] = useState<{ token: string; expiresAt: number } | undefined>();

  /** Where the user was heading before being asked to sign in. */
  const returnTo = resolveReturnTo(
    params.get('next'),
    (location.state as { from?: string } | null)?.from,
  );

  if (status === 'authenticated') return <Navigate to={returnTo} replace />;

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
        setChallenge({
          token: answer.challenge,
          expiresAt: Date.now() + TWO_FACTOR_CHALLENGE_TTL_MS,
        });
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

  const footer = (
    <p>
      No account yet? <Link to="/register">Create one</Link>
    </p>
  );

  /*
   * The second step, for an account with a second factor. The password has
   * been accepted and no session exists yet; the step owns its own form.
   */
  if (challenge) {
    return (
      <AuthCard title="Sign in" footer={footer}>
        <TwoFactorStep
          expiresAt={challenge.expiresAt}
          onSubmit={async (code) => {
            await completeTwoFactor(challenge.token, code);
            navigate(returnTo, { replace: true });
          }}
          onStartAgain={() => {
            setChallenge(undefined);
            setFormError(undefined);
            setValues((current) => ({ ...current, password: '' }));
          }}
        />
      </AuthCard>
    );
  }

  return (
    <AuthCard title="Sign in" footer={footer}>
      {reason === 'expired' ? (
        <Callout tone="info">Your session ended. Sign in to continue where you left off.</Callout>
      ) : null}

      <form className="auth-form" onSubmit={submit} noValidate>
        <Field
          id="identifier"
          label="Email or username"
          autoComplete="username"
          value={values.identifier}
          onChange={set('identifier')}
          error={errors.identifier}
          autoFocus
        />
        <PasswordField
          id="password"
          label="Password"
          autoComplete="current-password"
          value={values.password}
          onChange={(value) => set('password')({ target: { value } })}
          error={errors.password}
          action={<Link to="/forgot-password">Forgot your password?</Link>}
        />

        {formError ? <Callout tone="danger">{formError}</Callout> : null}

        <Button
          type="submit"
          variant="primary"
          size="lg"
          className="auth-form__submit"
          loading={submitting}
          loadingLabel="Signing in"
          {...(status === 'unknown'
            ? { disabledReason: 'Checking whether you are already signed in' }
            : {})}
        >
          Sign in
        </Button>
      </form>
    </AuthCard>
  );
}
