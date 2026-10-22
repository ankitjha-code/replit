import { useEffect, useState, type FormEvent, type ReactElement } from 'react';
import { Field } from '../../components/Field.js';
import { ApiError } from '../../lib/api-client.js';
import { fieldErrorsFrom } from '../../lib/form-errors.js';
import { Button, Callout } from '../../ui/index.js';

export interface TwoFactorStepProps {
  onSubmit: (code: string) => Promise<void>;
  onStartAgain: () => void;
  expiresAt?: number;
}

type Mode = 'app' | 'recovery';

interface Refusal {
  message: string;
  attemptsLeft?: number;
  expired: boolean;
}

function describeRefusal(error: unknown): Refusal {
  if (!(error instanceof ApiError)) {
    return { message: fieldErrorsFrom(error).message ?? 'Something went wrong.', expired: false };
  }
  const details = error.details as { attemptsRemaining?: unknown; reason?: unknown } | undefined;
  if (details?.reason === 'expired') return { message: '', expired: true };
  if (error.code === 'UNAUTHENTICATED') {
    const attemptsLeft =
      typeof details?.attemptsRemaining === 'number' ? details.attemptsRemaining : undefined;
    if (attemptsLeft === 0) return { message: 'Too many wrong codes.', expired: true };
    return {
      message: 'That code is not right. Try again.',
      ...(attemptsLeft !== undefined ? { attemptsLeft } : {}),
      expired: false,
    };
  }
  return { message: fieldErrorsFrom(error).message ?? error.message, expired: false };
}

export function TwoFactorStep({
  onSubmit,
  onStartAgain,
  expiresAt,
}: TwoFactorStepProps): ReactElement {
  const [mode, setMode] = useState<Mode>('app');
  const [code, setCode] = useState('');
  const [fieldError, setFieldError] = useState<string | undefined>();
  const [refusal, setRefusal] = useState<Refusal | undefined>();
  const [busy, setBusy] = useState(false);
  const [expired, setExpired] = useState(false);

  useEffect(() => {
    if (expiresAt === undefined) return;
    const wait = expiresAt - Date.now();
    if (wait <= 0) {
      setExpired(true);
      return;
    }
    const timer = setTimeout(() => setExpired(true), wait);
    return () => clearTimeout(timer);
  }, [expiresAt]);

  function switchMode(): void {
    setMode((current) => (current === 'app' ? 'recovery' : 'app'));
    setCode('');
    setFieldError(undefined);
    setRefusal(undefined);
  }

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setRefusal(undefined);

    const trimmed = code.replace(/\s+/g, '');
    if (mode === 'app' && !/^\d{6}$/.test(trimmed)) {
      setFieldError('Enter the 6-digit code from your authenticator app');
      return;
    }
    if (mode === 'recovery' && trimmed.length < 6) {
      setFieldError('Enter one of your recovery codes');
      return;
    }
    setFieldError(undefined);

    setBusy(true);
    try {
      await onSubmit(trimmed);
    } catch (error) {
      const described = describeRefusal(error);
      if (described.expired) setExpired(true);
      setRefusal(described);
      setBusy(false);
    }
  }

  if (expired || refusal?.expired) {
    return (
      <div className="auth-step">
        <h2 className="auth-step__title">Enter your code</h2>
        <Callout
          tone="warn"
          action={
            <Button variant="secondary" onClick={onStartAgain}>
              Start again
            </Button>
          }
        >
          {refusal?.message ? `${refusal.message} ` : ''}This sign-in attempt expired. Sign in again
          to get a new code.
        </Callout>
      </div>
    );
  }

  return (
    <div className="auth-step">
      <h2 className="auth-step__title">Enter your code</h2>
      <form className="auth-form" noValidate onSubmit={submit}>
        <p className="auth-step__lead">
          {mode === 'app'
            ? 'Open your authenticator app and type the 6-digit code it shows.'
            : 'Type one of the recovery codes you saved when you turned on two-factor sign-in.'}
        </p>

        <Field
          id="code"
          label={mode === 'app' ? 'Code' : 'Recovery code'}
          value={code}
          onChange={(event) => {
            setCode(event.target.value);
            setFieldError(undefined);
          }}
          autoComplete="one-time-code"
          inputMode={mode === 'app' ? 'numeric' : 'text'}
          {...(mode === 'app' ? { placeholder: '123456' } : {})}
          mono
          autoFocus
          error={fieldError}
        />

        {refusal && refusal.message ? (
          <Callout tone="danger">
            {refusal.message}
            {refusal.attemptsLeft !== undefined
              ? ` ${refusal.attemptsLeft} ${refusal.attemptsLeft === 1 ? 'attempt' : 'attempts'} left.`
              : ''}
          </Callout>
        ) : null}

        <Button
          type="submit"
          variant="primary"
          size="lg"
          className="auth-form__submit"
          loading={busy}
          loadingLabel="Checking your code"
        >
          Continue
        </Button>

        <div className="auth-form__links">
          <Button variant="link" onClick={switchMode}>
            {mode === 'app' ? 'Use a recovery code instead' : 'Use your authenticator app instead'}
          </Button>
          <Button variant="link" onClick={onStartAgain}>
            Start again
          </Button>
        </div>
      </form>
    </div>
  );
}
