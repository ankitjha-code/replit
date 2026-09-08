import { Link } from 'react-router-dom';
import { useAuth } from '../lib/auth-context.js';
import { ProjectsPage } from './ProjectsPage.js';

/**
 * The front door.
 *
 * A signed-in visitor lands on their projects; anyone else gets an invitation
 * to make an account. Redirecting an anonymous visitor to the sign-in form
 * instead would be a worse first impression and tells them nothing about what
 * they are signing in to.
 *
 * Renders nothing while the answer is unknown, so the page does not flash from
 * one to the other on every load.
 */
export function HomePage(): React.JSX.Element | null {
  const { status } = useAuth();

  if (status === 'unknown') return null;
  if (status === 'authenticated') return <ProjectsPage />;

  return (
    <div className="landing">
      <h1>Build and run applications in the browser</h1>
      <p>Create a project, edit code, run it in an isolated container, and share what you make.</p>
      <div className="landing__actions">
        <Link to="/register" className="button-primary button-primary--inline">
          Create an account
        </Link>
        <Link to="/login" className="button-quiet">
          Sign in
        </Link>
      </div>
    </div>
  );
}
