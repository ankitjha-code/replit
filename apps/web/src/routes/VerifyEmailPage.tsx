import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ApiError } from '../lib/api-client.js';
import { useAuth } from '../lib/auth-context.js';
import { confirmVerification } from '../lib/verification-api.js';
import '../styles/form.css';

/**
 * The page a verification link lands on.
 *
 * Not behind a sign-in guard, deliberately. A link is opened from an inbox,
 * which is often not the browser holding the session — a phone, a work machine,
 * a private window. The token is the proof; asking for a password as well would
 * make the link fail exactly where it is most likely to be used.
 *
 * It redeems on arrival rather than showing a button. The person already chose
 * by clicking the link in their mail; a second confirmation would be asking them
 * to agree to something they have already agreed to.
 */
export function VerifyEmailPage(): React.JSX.Element {
  const [params] = useSearchParams();
  const { refresh } = useAuth();
  const token = params.get('token');

  const [state, setState] = useState<'working' | 'done' | 'failed'>('working');
  const [message, setMessage] = useState<string>('');

  /*
   * Redeemed once, even though React may mount this twice.
   *
   * Strict mode runs effects twice in development, and the token is single use:
   * without this the second attempt is told the link has already been used, and
   * the page shows a failure for something that worked.
   */
  const attempted = useRef(false);

  useEffect(() => {
    if (attempted.current) return;
    attempted.current = true;

    if (!token) {
      setState('failed');
      setMessage('That link is missing its code. Ask for a new one.');
      return;
    }

    confirmVerification(token)
      .then(async () => {
        setState('done');
        // The signed-in user's own record now says verified; anything showing a
        // prompt about it should stop.
        await refresh().catch(() => undefined);
      })
      .catch((cause: unknown) => {
        setState('failed');
        setMessage(
          cause instanceof ApiError ? cause.message : 'That link could not be checked. Try again.',
        );
      });
  }, [token, refresh]);

  return (
    <div className="auth-card">
      <h1>Email address</h1>

      {state === 'working' && <p className="auth-subtitle">Checking your link…</p>}

      {state === 'done' && (
        <>
          <p className="auth-subtitle">Your address is confirmed. Thank you.</p>
          <p className="auth-switch">
            <Link to="/">Go to your projects</Link>
          </p>
        </>
      )}

      {state === 'failed' && (
        <>
          <p className="form-error">{message}</p>
          <p className="auth-switch">
            {/*
             * Sent to the account page rather than offered a "resend" button.
             * Asking for a new link needs a signed-in account, and a button here
             * would fail for exactly the person most likely to press it: somebody
             * reading their mail on a device they have never signed in on.
             */}
            <Link to="/account">Ask for a new link from your account</Link>
          </p>
        </>
      )}
    </div>
  );
}
