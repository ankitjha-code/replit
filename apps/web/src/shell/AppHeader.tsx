import { useEffect, useState, type ReactElement } from 'react';
import { Link, NavLink, useLocation, useMatch } from 'react-router-dom';
import { useAuth } from '../lib/auth-context.js';
import { getProject, listProjects } from '../lib/projects-api.js';
import { useResource } from '../lib/use-resource.js';
import { Breadcrumb, CommandPalette, IconButton, type BreadcrumbItem } from '../ui/index.js';
import { CubeTransparent, MagnifyingGlass } from '../ui/icons.js';
import { AccountMenu } from './AccountMenu.js';
import { useRenamedProjectName } from './project-renamed.js';
import { BRAND_NAME } from './brand.js';
import { ACCOUNT_PAGES, OPERATIONS_PAGES, SETTINGS_PAGES, useGlobalCommands } from './commands.js';
import { ShortcutsDialog } from './ShortcutsDialog.js';

/** Whether a key press belongs to the field the user is typing in. */
function inEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/**
 * The crumbs for the pages that sit under something: account sections,
 * operations sections and project settings. Everything else has none.
 */
function useHeaderCrumbs(): BreadcrumbItem[] | null {
  const account = useMatch('/account/*');
  const operations = useMatch('/operations/*');
  const settings = useMatch('/projects/:projectId/settings/*');
  const projectId = settings?.params.projectId;
  const project = useResource(
    (signal) => (projectId ? getProject(projectId, signal) : Promise.resolve(undefined)),
    [projectId],
  );
  // Settings > General renames without a navigation; this keeps the crumb in step.
  const renamedName = useRenamedProjectName(projectId);

  if (settings && projectId) {
    const slug = settings.params['*']?.split('/')[0] ?? '';
    const page = SETTINGS_PAGES.find((entry) => entry.slug === slug);
    const projectCrumb: BreadcrumbItem =
      project.status === 'loading'
        ? { loading: true }
        : {
            label: renamedName ?? project.data?.name ?? 'Project',
            to: `/projects/${projectId}`,
          };
    return [
      { label: 'Projects', to: '/' },
      projectCrumb,
      { label: 'Settings', ...(page ? { to: `/projects/${projectId}/settings` } : {}) },
      ...(page ? [{ label: page.label }] : []),
    ];
  }
  if (account) {
    const slug = account.params['*']?.split('/')[0] ?? '';
    const page = ACCOUNT_PAGES.find((entry) => entry.slug === slug && slug !== '');
    return [
      { label: 'Projects', to: '/' },
      { label: 'Account', ...(page ? { to: '/account' } : {}) },
      ...(page ? [{ label: page.label }] : []),
    ];
  }
  if (operations) {
    const slug = operations.params['*']?.split('/')[0] ?? '';
    const page = OPERATIONS_PAGES.find((entry) => entry.slug === slug && slug !== '');
    return [
      { label: 'Projects', to: '/' },
      { label: 'Operations', ...(page ? { to: '/operations' } : {}) },
      ...(page ? [{ label: page.label }] : []),
    ];
  }
  return null;
}

/**
 * The 44px bar on every page outside the workspace: brand, primary places,
 * where you are, search and the account menu. The workspace has no header;
 * its toolbar carries the brand and the account menu itself.
 */
export function AppHeader(): ReactElement {
  const { status, user } = useAuth();
  const location = useLocation();
  const signedIn = status === 'authenticated';
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const crumbs = useHeaderCrumbs();

  // The project list is only fetched for the palette, and only while it is open.
  const projects = useResource(
    (signal) => (paletteOpen && signedIn ? listProjects(signal) : Promise.resolve([])),
    [paletteOpen, signedIn],
  );
  const commands = useGlobalCommands({
    onShowShortcuts: () => setShortcutsOpen(true),
    ...(projects.data ? { projects: projects.data } : {}),
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented) return;
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen((open) => !open);
        return;
      }
      if (event.key === '?' && !event.metaKey && !event.ctrlKey && !event.altKey) {
        if (inEditableTarget(event.target)) return;
        event.preventDefault();
        setShortcutsOpen(true);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // A navigation closes whatever the header had open.
  useEffect(() => {
    setPaletteOpen(false);
  }, [location.pathname]);

  return (
    <header className="app-header" role="banner" aria-label="Site">
      <Link to="/" className="app-header__brand">
        <CubeTransparent
          size={20}
          weight="duotone"
          className="app-header__mark"
          aria-hidden="true"
        />
        <span>{BRAND_NAME}</span>
      </Link>
      {signedIn ? (
        <nav className="app-header__nav" aria-label="Primary">
          <NavLink to="/" end className="app-header__link">
            Projects
          </NavLink>
          {user?.isOperator ? (
            <NavLink to="/operations" className="app-header__link">
              Operations
            </NavLink>
          ) : null}
        </nav>
      ) : null}
      {crumbs ? (
        <div className="app-header__crumbs">
          <Breadcrumb items={crumbs} />
        </div>
      ) : null}
      <div className="app-header__actions">
        {signedIn ? (
          <IconButton
            label="Search"
            icon={MagnifyingGlass}
            shortcut={['Mod', 'K']}
            onClick={() => setPaletteOpen(true)}
          />
        ) : null}
        <AccountMenu onShowShortcuts={() => setShortcutsOpen(true)} />
      </div>
      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        commands={commands}
        placeholder="Search projects, pages and settings"
      />
      <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
    </header>
  );
}
