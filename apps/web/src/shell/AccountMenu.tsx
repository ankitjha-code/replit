import type { ReactElement } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../lib/auth-context.js';
import { useGuardedNavigate, useNavigationGuard } from '../lib/navigation-guard.js';
import { useTheme } from '../theme/use-theme.js';
import { Avatar, Button, Menu, Skeleton, type MenuGroup } from '../ui/index.js';
import { Keyboard, PlugsConnected, SignOut, SlidersHorizontal, User } from '../ui/icons.js';
import { THEME_CHOICES } from './commands.js';

/**
 * Pages whose own content carries the one accent-filled button (the landing's
 * "Create an account", each auth card's submit). The header's "Sign up" steps
 * down to secondary there so the screen keeps a single primary.
 */
const PAGES_WITH_THEIR_OWN_PRIMARY = new Set([
  '/',
  '/login',
  '/register',
  '/forgot-password',
  '/reset-password',
]);

export interface AccountMenuProps {
  /** Opens the shortcuts dialog; the item is left out when nothing is mounted to open. */
  onShowShortcuts?: () => void;
  className?: string;
}

/**
 * The identity corner: who you are and what belongs to you, or how to sign in.
 *
 * The trigger's accessible name is exactly the username (the avatar is hidden
 * from the name), so `getByText(username, { exact: true })` keeps finding it.
 * "Sign out" lives here and nowhere else on any page. Every item asks the
 * navigation guard first, so unsaved work in the workspace is flushed or the
 * user is asked before the page changes.
 */
export function AccountMenu({ onShowShortcuts, className }: AccountMenuProps): ReactElement {
  const { status, user, signOut } = useAuth();
  const { preference, setPreference } = useTheme();
  const navigate = useGuardedNavigate();
  const { confirmLeave } = useNavigationGuard();
  const { pathname } = useLocation();

  if (status === 'unknown') {
    // The shape of the signed-in control, so the header does not jump.
    return (
      <div className={className} aria-busy="true">
        <Skeleton shape="circle" width={24} height={24} />
      </div>
    );
  }

  if (status === 'anonymous' || !user) {
    return (
      <div className={`account-menu account-menu--out ${className ?? ''}`.trim()}>
        <Button variant="ghost" asChild>
          <Link to="/login">Sign in</Link>
        </Button>
        <Button
          variant={PAGES_WITH_THEIR_OWN_PRIMARY.has(pathname) ? 'secondary' : 'primary'}
          asChild
        >
          <Link to="/register">Sign up</Link>
        </Button>
      </div>
    );
  }

  const go = (to: string) => () => void navigate(to);

  const signOutGuarded = async (): Promise<void> => {
    if ((await confirmLeave()) !== 'proceed') return;
    // Home first, so the route guard never bounces through the sign-in page.
    await navigate('/');
    await signOut();
  };

  const groups: MenuGroup[] = [
    {
      label: user.email,
      items: [{ label: 'Account', icon: User, onSelect: go('/account') }],
    },
    {
      label: 'Theme',
      items: THEME_CHOICES.map((choice) => ({
        id: `theme-${choice.value}`,
        label: choice.label,
        checked: preference === choice.value,
        onSelect: () => setPreference(choice.value),
      })),
    },
    {
      items: [
        ...(onShowShortcuts
          ? [
              {
                label: 'Keyboard shortcuts',
                icon: Keyboard,
                shortcut: ['?'],
                onSelect: onShowShortcuts,
              },
            ]
          : []),
        ...(user.isOperator
          ? [
              { label: 'System status', icon: PlugsConnected, onSelect: go('/status') },
              { label: 'Operations', icon: SlidersHorizontal, onSelect: go('/operations') },
            ]
          : []),
      ],
    },
    {
      items: [{ label: 'Sign out', icon: SignOut, onSelect: () => void signOutGuarded() }],
    },
  ];

  const name = user.displayName || user.username;

  return (
    <Menu
      align="end"
      className="account-menu__menu"
      groups={groups}
      trigger={
        // The class is the hook the browser tests use to find the signed-in
        // control (e2e/tests/helpers.ts); keep it when restyling.
        <Button variant="ghost" className={`account-menu__trigger ${className ?? ''}`.trim()}>
          <span aria-hidden="true" className="account-menu__avatar">
            <Avatar name={name} userId={user.id} size={24} />
          </span>
          <span className="account-menu__name">{user.username}</span>
        </Button>
      }
    />
  );
}
