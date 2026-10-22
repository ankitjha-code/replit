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

/**
 * Whether the answer was about the link itself. A rate limit, a server
 * error or a lost connection says nothing about the link, which may still
 * work, so those are offered again rather than called dead.
 */
function linkWasRefused(cause: unknown): boolean {
  return cause instanceof ApiError && cause.status < 500 && cause.status !== 429;
}

/**
 * The page a verification link lands on.
 *
 * Not behind a sign-in guard, deliberately. A link is opened from an inbox,
 * which is often not the browser holding the session: a phone, a work machine,
 * a private window. The token is the proof; asking for a password as well would
 * make the link fail exactly where it is most likely to be used.
 *
 * It redeems on arrival rather than showing a button. The person already chose
 * by clicking the link in their mail; a second confirmation would be asking them
 * to agree to something they have already agreed to.
 */
export function VerifyEmailPage(): React.JSX.Element {
  const [params] = useSearchParams();
  const { status, refresh } = useAuth();
  const token = params.get('token');

  const [state, setState] = useState<VerifyState>('working');
  const [message, setMessage] = useState<string>('');

  /*
   * Redeemed once, even though React may mount this twice.
   *
   * Strict mode runs effects twice in development, and the token is single use:
   * without this the second attempt is told the link has already been used, and
   * the page shows a failure for something that worked.
   */
  const attempted = useRef(false);

  const redeem = useCallback(
    (link: string): void => {
      setState('working');
      confirmVerification(link)
        .then(async () => {
          setState('done');
          // The signed-in user's own record now says verified; anything showing a
          // prompt about it should stop.
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

  /*
   * Asking for a new link needs a signed-in account. A visitor reading mail on
   * a device they have never signed in on goes through sign-in first and lands
   * on the account page afterwards; a signed-in one goes straight there.
   */
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
