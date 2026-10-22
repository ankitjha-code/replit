import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ApiError } from '../lib/api-client.js';
import { useAuth } from '../lib/auth-context.js';
import { confirmVerification } from '../lib/verification-api.js';
import { Button, Callout, Skeleton } from '../ui/index.js';
import { AuthCard } from './auth/AuthCard.js';

type VerifyState = 'working' | 'done' | 'failed' | 'unchecked';

const TITLES: Record<VerifyState, string> = {
  working: 'Confirming your email…',
  done: 'Email confirmed',
  failed: 'This link no longer works',
  unchecked: 'This link could not be checked',
};

function linkWasRefused(cause: unknown): boolean {
  return cause instanceof ApiError && cause.status < 500 && cause.status !== 429;
}

export function VerifyEmailPage(): React.JSX.Element {
  const [params] = useSearchParams();
  const { status, refresh } = useAuth();
  const token = params.get('token');

  const [state, setState] = useState<VerifyState>('working');
  const [message, setMessage] = useState<string>('');

  const attempted = useRef(false);

  const redeem = useCallback(
    (link: string): void => {
      setState('working');
      confirmVerification(link)
        .then(async () => {
          setState('done');
          await refresh().catch(() => undefined);
        })
        .catch((cause: unknown) => {
          setState(linkWasRefused(cause) ? 'failed' : 'unchecked');
          setMessage(
            cause instanceof ApiError
              ? cause.message
              : 'That link could not be checked. Try again.',
          );
        });
    },
    [refresh],
  );

  useEffect(() => {
    if (attempted.current) return;
    attempted.current = true;

    if (!token) {
      setState('failed');
      setMessage(
        'This link is incomplete. Open the newest message from the platform and use the whole link, or request a new one.',
      );
      return;
    }

    redeem(token);
  }, [token, redeem]);

  const newLink =
    status === 'authenticated'
      ? { to: '/account', label: 'Request a new link' }
      : { to: '/login?next=/account', label: 'Sign in to request a new link' };

  return (
    <AuthCard title={TITLES[state]} busy={state === 'working'}>
      <div aria-live="polite" className="auth-panel__body">
        {state === 'working' ? <Skeleton lines={2} /> : null}

        {state === 'done' ? (
          <>
            <p className="auth-status">
              Your address is confirmed. Password resets and alerts can reach you now.
            </p>
            <Button variant="primary" size="lg" className="auth-form__submit" asChild>
              <Link to="/">Go to your projects</Link>
            </Button>
          </>
        ) : null}

        {state === 'unchecked' && token ? (
          <>
            <Callout tone="danger">{message}</Callout>
            <Button
              variant="primary"
              size="lg"
              className="auth-form__submit"
              onClick={() => redeem(token)}
            >
              Try again
            </Button>
          </>
        ) : null}

        {state === 'failed' ? (
          <>
            <Callout tone="danger">{message}</Callout>
            <Button variant="secondary" size="lg" className="auth-form__submit" asChild>
              <Link to={newLink.to}>{newLink.label}</Link>
            </Button>
          </>
        ) : null}
      </div>
    </AuthCard>
  );
}
