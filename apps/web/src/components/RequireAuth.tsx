import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../lib/auth-context.js';

/**
 * Keeps a route out of reach until the user is signed in.
 *
 * This is a rendering decision, not a security boundary. The server checks
 * every protected request regardless; hiding the page only spares the user a
 * screen full of errors. Anyone can edit the bundle, and it would not help
 * them.
 *
 * While the answer is still unknown the route renders nothing rather than
 * redirecting, or a refresh on a protected page would bounce to sign-in and
 * back on every load.
 */
export function RequireAuth({ children }: { children: React.ReactNode }): React.JSX.Element | null {
  const { status } = useAuth();
  const location = useLocation();

  if (status === 'unknown') return null;

  if (status === 'anonymous') {
    // Carried through so sign-in can return the user where they were going.
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  return <>{children}</>;
}
