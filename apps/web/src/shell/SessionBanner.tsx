import { useEffect, type ReactElement } from 'react';
import { useAuth } from '../lib/auth-context.js';
import { useNavigationGuard } from '../lib/navigation-guard.js';
import { Banner, Button } from '../ui/index.js';

export const SESSION_ENDED_MESSAGE =
  'Your session ended. Sign in again in a new tab to keep saving.';

/**
 * What happens when a 401 arrives while signed in. With unsaved work on the
 * page, the page stays mounted and this banner asks for a sign-in in another
 * tab; the auth provider keeps re-reading `/me` until the session is back.
 * With nothing to lose, the session is simply expired and the route guard
 * sends the user to sign in, remembering where they were.
 */
export function SessionBanner(): ReactElement | null {
  const { sessionEnded, expireSession } = useAuth();
  const { hasDirty } = useNavigationGuard();

  useEffect(() => {
    if (sessionEnded && !hasDirty()) expireSession();
  }, [sessionEnded, hasDirty, expireSession]);

  if (!sessionEnded) return null;
  return (
    <Banner
      tone="danger"
      message={SESSION_ENDED_MESSAGE}
      className="shell-banner"
      action={
        <Button variant="primary" size="sm" asChild>
          <a href="/login" target="_blank" rel="noopener">
            Sign in
          </a>
        </Button>
      }
    />
  );
}
