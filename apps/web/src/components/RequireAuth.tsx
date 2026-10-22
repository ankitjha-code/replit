import type { ReactElement, ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../lib/auth-context.js';
import { Skeleton } from '../ui/index.js';

/** What a page looks like before anything is known: the shape of text, not a spinner. */
export function PageSkeleton(): ReactElement {
  return (
    <div className="page-skeleton" aria-busy="true" aria-label="Loading">
      <Skeleton width={220} height={24} />
      <Skeleton lines={3} />
    </div>
  );
}

/**
 * Keeps a route out of reach until the user is signed in.
 *
 * This is a rendering decision, not a security boundary. The server checks
 * every protected request regardless; hiding the page only spares the user a
 * screen full of errors. Anyone can edit the bundle, and it would not help
 * them.
 *
 * While the answer is still unknown the route shows a skeleton rather than
 * redirecting, or a refresh on a protected page would bounce to sign-in and
 * back on every load.
 */
export function RequireAuth({ children }: { children: ReactNode }): ReactElement {
  const { status } = useAuth();
  const location = useLocation();

  if (status === 'unknown') return <PageSkeleton />;

  if (status === 'anonymous') {
    // Carried through so sign-in can return the user where they were going.
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  return <>{children}</>;
}
