import type { ReactElement } from 'react';
import { useAuth } from '../lib/auth-context.js';
import { Landing } from './projects/Landing.js';
import { ProjectsPage } from './ProjectsPage.js';

/**
 * The front door.
 *
 * A signed-in visitor lands on their projects; anyone else gets an invitation
 * to make an account. Redirecting an anonymous visitor to the sign-in form
 * instead would be a worse first impression and tells them nothing about what
 * they are signing in to.
 *
 * While `/me` is still being answered the landing renders with a skeleton in
 * place of its headline, so the page is never blank and never claims a state
 * it does not know yet.
 */
export function HomePage(): ReactElement {
  const { status, reachable, refresh } = useAuth();

  if (status === 'authenticated') return <ProjectsPage />;
  if (status === 'unknown') return <Landing loading />;

  return <Landing unreachable={!reachable} onRetry={() => void refresh()} />;
}
