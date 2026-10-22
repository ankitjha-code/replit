import { useEffect, type ReactElement } from 'react';
import { useAuth } from '../lib/auth-context.js';
import { useNavigationGuard } from '../lib/navigation-guard.js';
import { Banner, Button } from '../ui/index.js';

export const SESSION_ENDED_MESSAGE =
  'Your session ended. Sign in again in a new tab to keep saving.';

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
