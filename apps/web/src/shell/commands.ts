import { useMemo } from 'react';
import { useMatch } from 'react-router-dom';
import type { ProjectSummary } from '@platform/shared';
import { useAuth } from '../lib/auth-context.js';
import { useGuardedNavigate, useNavigationGuard } from '../lib/navigation-guard.js';
import { openCreateProject } from '../routes/projects/create-project-request.js';
import { useTheme } from '../theme/use-theme.js';
import type { ThemePreference } from '../theme/theme.js';
import type { PaletteCommand } from '../ui/index.js';
import {
  Cube,
  Database,
  Gear,
  GitBranch,
  GitCommit,
  Keyboard,
  ListDashes,
  Monitor,
  Moon,
  Package,
  PlugsConnected,
  Plus,
  Pulse,
  RocketLaunch,
  Scroll,
  SignOut,
  SlidersHorizontal,
  Sun,
  User,
  Users,
  type Icon,
} from '../ui/icons.js';

export const SETTINGS_PAGES: ReadonlyArray<{ slug: string; label: string; icon: Icon }> = [
  { slug: 'general', label: 'General', icon: Gear },
  { slug: 'people', label: 'People', icon: Users },
  { slug: 'environment', label: 'Environment', icon: Cube },
  { slug: 'database', label: 'Database', icon: Database },
  { slug: 'assets', label: 'Assets', icon: Package },
  { slug: 'deploy', label: 'Deploy', icon: RocketLaunch },
  { slug: 'history', label: 'History', icon: GitCommit },
  { slug: 'git', label: 'Git', icon: GitBranch },
  { slug: 'monitoring', label: 'Monitoring', icon: Pulse },
  { slug: 'logs', label: 'Logs', icon: Scroll },
];

export const ACCOUNT_PAGES: ReadonlyArray<{ slug: string; label: string }> = [
  { slug: '', label: 'Profile' },
  { slug: 'security', label: 'Security' },
  { slug: 'sessions', label: 'Sessions' },
  { slug: 'usage', label: 'Usage' },
  { slug: 'close', label: 'Close account' },
];

export const OPERATIONS_PAGES: ReadonlyArray<{ slug: string; label: string }> = [
  { slug: '', label: 'Overview' },
  { slug: 'hosts', label: 'Hosts' },
  { slug: 'accounts', label: 'Accounts' },
  { slug: 'cleanup', label: 'Cleanup' },
  { slug: 'audit', label: 'Audit' },
];

export const THEME_CHOICES: ReadonlyArray<{ value: ThemePreference; label: string; icon: Icon }> = [
  { value: 'system', label: 'System', icon: Monitor },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'light', label: 'Light', icon: Sun },
];

export interface GlobalCommandOptions {
  onShowShortcuts?: () => void;
  projects?: ProjectSummary[];
}

export function useGlobalCommands(options: GlobalCommandOptions = {}): PaletteCommand[] {
  const { onShowShortcuts, projects } = options;
  const { status, user, signOut } = useAuth();
  const { preference, setPreference } = useTheme();
  const navigate = useGuardedNavigate();
  const { confirmLeave } = useNavigationGuard();
  const projectMatch = useMatch('/projects/:projectId/*');
  const projectId = projectMatch?.params.projectId;
  const signedIn = status === 'authenticated';
  const isOperator = user?.isOperator === true;

  return useMemo(() => {
    const go = (to: string) => () => void navigate(to);
    const commands: PaletteCommand[] = [];

    if (signedIn) {
      commands.push(
        {
          id: 'go-projects',
          label: 'Your projects',
          icon: ListDashes,
          group: 'Go to',
          onSelect: go('/'),
        },
        {
          id: 'new-project',
          label: 'New project',
          icon: Plus,
          group: 'Go to',
          keywords: ['create', 'starter', 'template'],
          onSelect: () => {
            void (async () => {
              if ((await confirmLeave()) !== 'proceed') return;
              openCreateProject('blank');
              await navigate('/');
            })();
          },
        },
        {
          id: 'go-account',
          label: 'Account',
          icon: User,
          group: 'Go to',
          onSelect: go('/account'),
        },
      );
    }
    commands.push({
      id: 'go-status',
      label: 'System status',
      icon: PlugsConnected,
      group: 'Go to',
      onSelect: go('/status'),
    });
    if (isOperator) {
      commands.push({
        id: 'go-operations',
        label: 'Operations',
        icon: SlidersHorizontal,
        group: 'Go to',
        onSelect: go('/operations'),
      });
    }

    for (const project of projects ?? []) {
      commands.push({
        id: `open-${project.id}`,
        label: `Open ${project.name}`,
        icon: Cube,
        group: 'Projects',
        keywords: [project.slug],
        onSelect: go(`/projects/${project.id}`),
      });
    }

    if (projectId) {
      for (const page of SETTINGS_PAGES) {
        commands.push({
          id: `settings-${page.slug}`,
          label: `Settings: ${page.label}`,
          icon: page.icon,
          group: 'This project',
          onSelect: go(`/projects/${projectId}/settings/${page.slug}`),
        });
      }
    }

    for (const choice of THEME_CHOICES) {
      commands.push({
        id: `theme-${choice.value}`,
        label: `Theme: ${choice.label}`,
        icon: choice.icon,
        group: 'Theme',
        keywords: ['appearance', 'dark mode', 'light mode'],
        ...(preference === choice.value ? { disabledReason: 'Current theme' } : {}),
        onSelect: () => setPreference(choice.value),
      });
    }

    if (onShowShortcuts) {
      commands.push({
        id: 'shortcuts',
        label: 'Keyboard shortcuts',
        icon: Keyboard,
        shortcut: ['?'],
        group: 'Help',
        onSelect: onShowShortcuts,
      });
    }

    if (signedIn) {
      commands.push({
        id: 'sign-out',
        label: 'Sign out',
        icon: SignOut,
        group: 'Account',
        onSelect: () => {
          void (async () => {
            if ((await confirmLeave()) !== 'proceed') return;
            await navigate('/');
            await signOut();
          })();
        },
      });
    }

    return commands;
  }, [
    signedIn,
    isOperator,
    projects,
    projectId,
    preference,
    setPreference,
    onShowShortcuts,
    navigate,
    confirmLeave,
    signOut,
  ]);
}
