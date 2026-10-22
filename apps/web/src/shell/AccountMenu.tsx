import type { ReactElement } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../lib/auth-context.js';
import { useGuardedNavigate, useNavigationGuard } from '../lib/navigation-guard.js';
import { useTheme } from '../theme/use-theme.js';
import { Avatar, Button, Menu, Skeleton, type MenuGroup } from '../ui/index.js';
import { Keyboard, PlugsConnected, SignOut, SlidersHorizontal, User } from '../ui/icons.js';
import { THEME_CHOICES } from './commands.js';

const PAGES_WITH_THEIR_OWN_PRIMARY = new Set([
  '/',
  '/login',
  '/register',
  '/forgot-password',
  '/reset-password',
]);

export interface AccountMenuProps {
  onShowShortcuts?: () => void;
  className?: string;
}

export function AccountMenu({ onShowShortcuts, className }: AccountMenuProps): ReactElement {
  const { status, user, signOut } = useAuth();
  const { preference, setPreference } = useTheme();
  const navigate = useGuardedNavigate();
  const { confirmLeave } = useNavigationGuard();
  const { pathname } = useLocation();

  if (status === 'unknown') {
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
