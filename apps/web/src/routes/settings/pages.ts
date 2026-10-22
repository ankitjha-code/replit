import type { ProjectRole } from '@platform/shared';
import {
  Cube,
  Database,
  Gear,
  GitBranch,
  GitCommit,
  Package,
  Pulse,
  RocketLaunch,
  Scroll,
  Users,
  type Icon,
} from '../../ui/icons.js';

/**
 * The settings information architecture (design spec 6.3): ten pages in five
 * groups named after what the person is trying to do, not after the module
 * that serves them. Every group is always visible; an owner-only page shows a
 * lock to everyone else and explains itself instead of vanishing.
 */

export type SettingsPageId =
  | 'general'
  | 'people'
  | 'environment'
  | 'database'
  | 'assets'
  | 'deploy'
  | 'history'
  | 'git'
  | 'monitoring'
  | 'logs';

export interface SettingsPageDef {
  id: SettingsPageId;
  label: string;
  icon: Icon;
  /** The whole page needs the OWNER role on the server. */
  ownerOnly: boolean;
}

export interface SettingsGroupDef {
  label: string;
  pages: SettingsPageDef[];
}

export const SETTINGS_GROUPS: readonly SettingsGroupDef[] = [
  {
    label: 'Project',
    pages: [
      { id: 'general', label: 'General', icon: Gear, ownerOnly: false },
      { id: 'people', label: 'People', icon: Users, ownerOnly: false },
    ],
  },
  {
    label: 'Run',
    pages: [
      { id: 'environment', label: 'Environment', icon: Cube, ownerOnly: false },
      { id: 'database', label: 'Database', icon: Database, ownerOnly: true },
      { id: 'assets', label: 'Assets', icon: Package, ownerOnly: false },
    ],
  },
  {
    label: 'Ship',
    pages: [{ id: 'deploy', label: 'Deploy', icon: RocketLaunch, ownerOnly: true }],
  },
  {
    label: 'Safety',
    pages: [
      { id: 'history', label: 'History', icon: GitCommit, ownerOnly: false },
      { id: 'git', label: 'Git', icon: GitBranch, ownerOnly: false },
    ],
  },
  {
    label: 'Observe',
    pages: [
      { id: 'monitoring', label: 'Monitoring', icon: Pulse, ownerOnly: false },
      { id: 'logs', label: 'Logs', icon: Scroll, ownerOnly: false },
    ],
  },
];

export const SETTINGS_PAGES: readonly SettingsPageDef[] = SETTINGS_GROUPS.flatMap(
  (group) => group.pages,
);

export function findSettingsPage(id: string | undefined): SettingsPageDef | undefined {
  return SETTINGS_PAGES.find((page) => page.id === id);
}

export function settingsPath(projectId: string, page?: SettingsPageId): string {
  const base = `/projects/${encodeURIComponent(projectId)}/settings`;
  return page ? `${base}/${page}` : base;
}

/** Whether this person may open a page's content, mirroring the server's checks. */
export function canOpenSettingsPage(page: SettingsPageDef, role: ProjectRole): boolean {
  return !page.ownerOnly || role === 'OWNER';
}
