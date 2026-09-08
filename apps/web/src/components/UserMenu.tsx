import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../lib/auth-context.js';

/**
 * The identity corner of the shell: who you are, or how to sign in.
 *
 * Renders nothing while the answer is still unknown, so the header does not
 * flash from signed-out to signed-in on every page load.
 */
export function UserMenu(): React.JSX.Element | null {
  const { status, user, signOut } = useAuth();
  const [leaving, setLeaving] = useState(false);

  if (status === 'unknown') return null;

  if (status === 'anonymous' || !user) {
    return (
      <div className="user-menu">
        <Link to="/login" className="button-quiet">
          Sign in
        </Link>
        <Link to="/register" className="button-quiet button-quiet--accent">
          Sign up
        </Link>
      </div>
    );
  }

  return (
    <div className="user-menu">
      {/*
       * The name is the way in to the account page.
       *
       * Where people already look for it, and it costs no room in a header
       * that has none. The title still carries the email, which is what
       * somebody hovering is usually checking.
       */}
      <Link to="/account" className="user-menu__name" title={user.email}>
        {user.username}
      </Link>
      <button
        type="button"
        className="button-quiet"
        disabled={leaving}
        onClick={() => {
          setLeaving(true);
          // signOut never rejects, so there is nothing to catch here.
          void signOut().finally(() => setLeaving(false));
        }}
      >
        {leaving ? 'Signing out…' : 'Sign out'}
      </button>
    </div>
  );
}
