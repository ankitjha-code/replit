import { useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { PASSWORD_MIN_LENGTH, registerRequestSchema } from '@platform/shared';
import { Field } from '../components/Field.js';
import { useAuth } from '../lib/auth-context.js';
import { fieldErrorsFrom, type FieldErrors } from '../lib/form-errors.js';
import '../styles/form.css';

export function RegisterPage(): React.JSX.Element {
  const { status, register } = useAuth();
  const navigate = useNavigate();

  const [values, setValues] = useState({ email: '', username: '', password: '' });
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

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setFormError(undefined);

    // Checked here for immediate feedback. The server checks again and its
    // answer is the one that counts.
    const parsed = registerRequestSchema.safeParse(values);
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
    <div className="auth-card">
      <h1>Create your account</h1>
      <p className="auth-subtitle">Build and run applications in the browser.</p>

      <form onSubmit={submit} noValidate>
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
          error={errors.username}
          hint="Letters, numbers and hyphens. This appears in your URLs."
        />
        <Field
          id="password"
          label="Password"
          type="password"
          autoComplete="new-password"
          value={values.password}
          onChange={set('password')}
          error={errors.password}
          hint={`At least ${PASSWORD_MIN_LENGTH} characters. A passphrase works well.`}
        />

        {formError && (
          <p className="form-error" role="alert">
            {formError}
          </p>
        )}

        <button type="submit" className="button-primary" disabled={submitting}>
          {submitting ? 'Creating account…' : 'Create account'}
        </button>
      </form>

      <p className="auth-switch">
        Already have an account? <Link to="/login">Sign in</Link>
      </p>
    </div>
  );
}
