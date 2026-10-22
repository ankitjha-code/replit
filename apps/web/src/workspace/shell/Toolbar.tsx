import { useState, type ReactElement, type Ref } from 'react';
import { Link } from 'react-router-dom';
import type { ProjectSummary } from '@platform/shared';
import { useGuardedNavigate } from '../../lib/navigation-guard.js';
import { AccountMenu } from '../../shell/AccountMenu.js';
import { BRAND_NAME } from '../../shell/brand.js';
import { Button, IconButton, Menu, type MenuItem } from '../../ui/index.js';
import {
  ArrowLeft,
  CaretUpDown,
  CubeTransparent,
  DotsThree,
  Gear,
  GitCommit,
  Keyboard,
  MagnifyingGlass,
  PencilSimple,
  RocketLaunch,
  Scroll,
  ShareNetwork,
} from '../../ui/icons.js';
import { PresenceBar, ConnectionStatus } from '../PresenceBar.js';
import type { ProjectPresence } from '../use-project-events.js';
import type { LayoutControls as LayoutState } from '../use-layout.js';
import type { RuntimeControls as RuntimeState } from '../use-runtime.js';
import { EnvironmentControl } from './EnvironmentControl.js';
import { LayoutControls, LAYOUT_DEFAULT_REASON } from './LayoutControls.js';
import { ShareDialog, SharePopover } from './SharePopover.js';
import type { ShareSection } from './workspace-actions.js';

/**
 * The one 44px bar above the panels (design spec 9.1). It replaces the global
 * header inside the workspace, so it carries the brand, the way back and the
 * account menu as well as the project's own controls.
 *
 * Below 768px it collapses (9.10): back, name, the Environment half, one
 * overflow menu and the account menu. Nothing here may overlap: the audit's
 * blocking phone bug was "Reset layout" painted over "Start".
 */
export interface ToolbarProps {
  project: ProjectSummary;
  runtime: RuntimeState;
  presence: ProjectPresence;
  /** The browser believes it has a network. */
  online: boolean;
  canControl: boolean;
  /** The project's application is running, so stopping the environment asks first. */
  appRunning: boolean;
  /** The Start/Stop button, for `focusStart()` and the guide strip. */
  startRef: Ref<HTMLButtonElement>;
  layout: LayoutState;
  phone: boolean;
  shareOpen: boolean;
  /** The part of Share to open at, when something asked for one. */
  shareSection?: ShareSection | undefined;
  onShareOpenChange: (open: boolean) => void;
  onShowShortcuts: () => void;
  onOpenPalette: () => void;
}

export function Toolbar(props: ToolbarProps): ReactElement {
  return props.phone ? <PhoneToolbar {...props} /> : <DesktopToolbar {...props} />;
}

function DesktopToolbar({
  project,
  runtime,
  presence,
  online,
  canControl,
  appRunning,
  startRef,
  layout,
  shareOpen,
  shareSection,
  onShareOpenChange,
  onShowShortcuts,
  onOpenPalette,
}: ToolbarProps): ReactElement {
  const settings = `/projects/${project.id}/settings`;

  return (
    <header className="ws-toolbar" aria-label="Workspace toolbar">
      <div className="ws-toolbar__crumbs">
        <Link to="/" className="ws-toolbar__brand" aria-label={BRAND_NAME}>
          <CubeTransparent size={20} weight="duotone" aria-hidden="true" />
        </Link>
        {/* The pinned name "All projects" (tests and the audit both read it);
            the visible word is the crumb's. */}
        <Link to="/" className="ws-toolbar__crumb" aria-label="All projects">
          Projects
        </Link>
        <span className="ws-toolbar__separator" aria-hidden="true">
          ›
        </span>
        <h1 className="ws-toolbar__title">
          <ProjectMenu project={project} />
        </h1>
        <span className="ws-toolbar__slug">/{project.slug}</span>
      </div>

      <EnvironmentControl
        runtime={runtime}
        canControl={canControl}
        projectId={project.id}
        appRunning={appRunning}
        startRef={startRef}
      />

      <div className="ws-toolbar__people">
        <PresenceBar others={presence.others} connected={presence.connected} />
        <ConnectionStatus status={presence.status} online={online} />
      </div>

      <div className="ws-toolbar__actions">
        <SharePopover
          projectId={project.id}
          role={project.role}
          open={shareOpen}
          section={shareSection}
          onOpenChange={onShareOpenChange}
        />
        <Button variant="ghost" size="sm" icon={Gear} asChild className="ws-toolbar__settings">
          <Link to={settings}>
            <span className="ws-toolbar__label">Settings</span>
          </Link>
        </Button>
        <LayoutControls layout={layout} onShowShortcuts={onShowShortcuts} />
        <IconButton
          label="Search"
          icon={MagnifyingGlass}
          size="sm"
          shortcut={['Mod', 'K']}
          onClick={onOpenPalette}
        />
        <AccountMenu onShowShortcuts={onShowShortcuts} className="ws-toolbar__account" />
      </div>
    </header>
  );
}

function PhoneToolbar({
  project,
  runtime,
  canControl,
  appRunning,
  startRef,
  layout,
  shareOpen,
  shareSection,
  onShareOpenChange,
  onShowShortcuts,
}: ToolbarProps): ReactElement {
  const navigate = useGuardedNavigate();
  const settings = `/projects/${project.id}/settings`;

  const items: MenuItem[] = [
    { id: 'share', label: 'Share', icon: ShareNetwork, onSelect: () => onShareOpenChange(true) },
    { id: 'settings', label: 'Settings', icon: Gear, onSelect: () => void navigate(settings) },
    {
      id: 'reset',
      label: 'Reset layout',
      onSelect: layout.reset,
      ...(layout.isDefault ? { disabledReason: LAYOUT_DEFAULT_REASON } : {}),
    },
    { id: 'shortcuts', label: 'Keyboard shortcuts', icon: Keyboard, onSelect: onShowShortcuts },
  ];

  return (
    <header className="ws-toolbar ws-toolbar--phone" aria-label="Workspace toolbar">
      <Link to="/" className="ws-toolbar__back" aria-label="All projects">
        <ArrowLeft size={20} aria-hidden="true" />
      </Link>
      <h1 className="ws-toolbar__title ws-toolbar__title--plain">{project.name}</h1>
      <EnvironmentControl
        runtime={runtime}
        canControl={canControl}
        projectId={project.id}
        appRunning={appRunning}
        startRef={startRef}
        compact
      />
      <div className="ws-toolbar__actions">
        <Menu
          align="end"
          items={items}
          trigger={<IconButton label="More" icon={DotsThree} className="ws-toolbar__more" />}
        />
        <AccountMenu className="ws-toolbar__account" />
      </div>
      <ShareDialog
        projectId={project.id}
        role={project.role}
        open={shareOpen}
        section={shareSection}
        onOpenChange={onShareOpenChange}
      />
    </header>
  );
}

/**
 * The project name is the heading and a menu of the places that belong to
 * the project (design spec 6.4). Every destination goes through the
 * navigation guard, so unsaved work is asked about first.
 */
function ProjectMenu({ project }: { project: ProjectSummary }): ReactElement {
  const navigate = useGuardedNavigate();
  const [open, setOpen] = useState(false);
  const settings = `/projects/${project.id}/settings`;
  const go = (to: string, state?: unknown) => () =>
    void navigate(to, state === undefined ? undefined : { state });

  const items: MenuItem[] = [
    { id: 'settings', label: 'Settings', icon: Gear, onSelect: go(`${settings}/general`) },
    {
      id: 'deployments',
      label: 'Deployments',
      icon: RocketLaunch,
      onSelect: go(`${settings}/deploy`),
    },
    {
      id: 'snapshots',
      label: 'Snapshots',
      icon: GitCommit,
      onSelect: go(`${settings}/history#history-snapshots`),
    },
    { id: 'history', label: 'History', icon: GitCommit, onSelect: go(`${settings}/history`) },
    { id: 'logs', label: 'Logs', icon: Scroll, onSelect: go(`${settings}/logs`) },
  ];
  const rename: MenuItem[] = [
    {
      id: 'rename',
      label: 'Rename…',
      icon: PencilSimple,
      // The General page focuses the name field when it arrives with this state.
      onSelect: go(`${settings}/general`, { focus: 'project-name' }),
    },
  ];

  return (
    <Menu
      open={open}
      onOpenChange={setOpen}
      align="start"
      label={`${project.name} menu`}
      groups={[{ items }, { items: rename }]}
      trigger={
        <Button
          variant="ghost"
          size="sm"
          iconEnd={CaretUpDown}
          className="ws-toolbar__project"
          aria-haspopup="menu"
        >
          {project.name}
        </Button>
      }
    />
  );
}
