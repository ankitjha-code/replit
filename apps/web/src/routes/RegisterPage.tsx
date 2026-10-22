import { useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { RESERVED_USERNAMES, registerRequestSchema } from '@platform/shared';
import { Field } from '../components/Field.js';
import { useAuth } from '../lib/auth-context.js';
import { fieldErrorsFrom, type FieldErrors } from '../lib/form-errors.js';
import { Button, Callout } from '../ui/index.js';
import { AuthCard } from './auth/AuthCard.js';
import { PasswordField } from './auth/PasswordField.js';
import { PasswordRules, passwordRules } from './auth/PasswordRules.js';

const RESERVED_MESSAGE = 'That username is reserved by the platform';

/**
 * What an empty required field says. The shared schema's own message for an
 * empty email is Zod's generic "Too small", which tells nobody what to do.
 */
const BLANK_MESSAGES: Record<string, string> = {
  email: 'Enter your email address',
  username: 'Choose a username',
  password: 'Choose a password',
};

export function RegisterPage(): React.JSX.Element {
  const { status, register } = useAuth();
  const navigate = useNavigate();

  const [values, setValues] = useState({ email: '', username: '', displayName: '', password: '' });
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | undefined>();
  const [submitting, setSubmitting] = useState(false);

  // Registration signs the user in, so someone already signed in has no
  // business here.
  if (status === 'authenticated') return <Navigate to="/" replace />;

  const set = (field: keyof typeof values) => (event: { target: { value: string } }) => {
    setValues((current) => ({ ...current, [field]: event.target.value }));
    // Clear the error the moment the user starts addressing it; leaving it
    // under a field being edited reads as though the edit did not register.
    setErrors((current) => ({ ...current, [field]: undefined }));
  };

  /** The one username rule worth raising before submit: a reserved name can never be fixed by retrying. */
  function checkReservedUsername(): void {
    if (RESERVED_USERNAMES.has(values.username.trim().toLowerCase())) {
      setErrors((current) => ({ ...current, username: RESERVED_MESSAGE }));
    }
  }

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setFormError(undefined);

    // Checked here for immediate feedback. The server checks again and its
    // answer is the one that counts. The display name is optional and the
    // schema refuses an empty one, so it is left out rather than sent blank.
    const displayName = values.displayName.trim();
    const parsed = registerRequestSchema.safeParse({
      email: values.email,
      username: values.username,
      password: values.password,
      ...(displayName ? { displayName } : {}),
    });
    if (!parsed.success) {
      const fields: FieldErrors = {};
      for (const issue of parsed.error.issues) {
        const path = issue.path.map(String).join('.');
        if (!path || path in fields) continue;
        const blank = path in values && values[path as keyof typeof values].trim() === '';
        fields[path] = blank ? (BLANK_MESSAGES[path] ?? issue.message) : issue.message;
      }
      setErrors(fields);
      return;
    }

    setSubmitting(true);
    try {
      await register(parsed.data);
      navigate('/', { replace: true });
    } catch (error) {
      const mapped = fieldErrorsFrom(error);
      setErrors(mapped.fields);
      if (mapped.message) setFormError(mapped.message);
      setSubmitting(false);
    }
  }

  return (
    <AuthCard
      title="Create your account"
      description="Build and run applications in the browser."
      footer={
        <p>
          Already have an account? <Link to="/login">Sign in</Link>
        </p>
      }
    >
      <form className="auth-form" onSubmit={submit} noValidate>
        <Field
          id="email"
          label="Email"
          type="email"
          autoComplete="email"
          value={values.email}
          onChange={set('email')}
          error={errors.email}
          autoFocus
        />
        <Field
          id="username"
          label="Username"
          autoComplete="username"
          value={values.username}
          onChange={set('username')}
          onBlur={checkReservedUsername}
          error={errors.username}
          hint="Letters, numbers and hyphens. Shown to people you work with."
        />
        <Field
          id="displayName"
          label="Display name (optional)"
          autoComplete="name"
          value={values.displayName}
          onChange={set('displayName')}
          error={errors.displayName}
        />
        <PasswordField
          id="password"
          label="Password"
          autoComplete="new-password"
          value={values.password}
          onChange={(value) => set('password')({ target: { value } })}
          error={errors.password}
        />
        <PasswordRules rules={passwordRules(values.password, values.username)} />

        {formError ? <Callout tone="danger">{formError}</Callout> : null}

        <Button
          type="submit"
          variant="primary"
          size="lg"
          className="auth-form__submit"
          loading={submitting}
          loadingLabel="Creating your account"
        >
          Create account
        </Button>
      </form>
    </AuthCard>
  );
}
