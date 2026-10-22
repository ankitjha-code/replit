import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type RefObject,
} from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import type { ProjectEvent, ProjectSummary, RuntimeStatus } from '@platform/shared';
import { AnnounceContext, writeLiveRegion, type Announce } from '../lib/announce.js';
import { ApiError } from '../lib/api-client.js';
import { useAuth } from '../lib/auth-context.js';
import { searchFiles } from '../lib/files-api.js';
import { canControl as roleCanControl, canWrite as roleCanWrite } from '../lib/permissions.js';
import { getProject } from '../lib/projects-api.js';
import { useDocumentTitle } from '../lib/use-document-title.js';
import { useOnline } from '../lib/use-online.js';
import { useResource } from '../lib/use-resource.js';
import { NotFoundPage } from '../routes/NotFoundPage.js';
import { recordProjectOpened } from '../routes/projects/project-prefs.js';
import { useGlobalCommands } from '../shell/commands.js';
import { ShortcutsDialog } from '../shell/ShortcutsDialog.js';
import {
  Button,
  Callout,
  CommandPalette,
  Skeleton,
  type PaletteCommand,
  type PaletteFiles,
} from '../ui/index.js';
import {
  ArrowClockwise,
  ArrowsClockwise,
  Browser,
  FilePlus,
  FolderPlus,
  FolderSimple,
  Play,
  SidebarSimple,
  SlidersHorizontal,
  Stop,
  TerminalWindow,
  UploadSimple,
  Users,
} from '../ui/icons.js';
import { adjustEditorFontSize, openEditorSettings } from './editor/editor-settings.js';
import { useOpenFiles } from './editor/use-open-files.js';
import { FILES_EVENTS, dispatchFilesEvent } from './files/files-events.js';
import { GuideStrip, type GuideStage } from './shell/GuideStrip.js';
import { PhoneSwitcher } from './shell/PhoneSwitcher.js';
import {
  WORKSPACE_EVENTS,
  dispatchWorkspaceEvent,
  useWorkspaceShortcuts,
} from './shell/shortcuts.js';
import { Toolbar } from './shell/Toolbar.js';
import { useAppRunning } from './shell/use-app-state.js';
import { useIsPhone } from './shell/use-phone.js';
import {
  WorkspaceActionsContext,
  flashElement,
  type ConsoleTab,
  type PreviewReport,
  type RunActions,
  type ShareSection,
  type WorkspaceActions,
  type WorkspacePanelName,
} from './shell/workspace-actions.js';
import { statusLabel } from './RuntimeControls.js';
import { WorkspaceLayout } from './WorkspaceLayout.js';
import { useWorkspaceLayout } from './use-layout.js';
import { useProjectEvents } from './use-project-events.js';
import { useRuntime } from './use-runtime.js';
import './shell/workspace.css';

/** How long after the last file change the runtime is asked about again. */
const DETECTION_REFRESH_MS = 300;

/**
 * A project's workspace.
 *
 * Loads the project, then hands over to the frame. The not-found case uses the
 * same page as an unknown route because the server deliberately does not say
 * whether a project is missing or merely not the caller's.
 */
export function WorkspacePage(): ReactElement {
  const { projectId } = useParams<{ projectId: string }>();
  const project = useResource(
    (signal) =>
      projectId ? getProject(projectId, signal) : Promise.reject(new Error('No project')),
    [projectId],
    { keepPrevious: false },
  );

  if (project.status === 'error' || (project.status === 'ready' && !project.data)) {
    const notFound = project.error instanceof ApiError && project.error.code === 'NOT_FOUND';
    if (notFound) return <NotFoundPage />;
    return (
      <div className="workspace workspace--message">
        <Callout
          tone="danger"
          title="The project could not be opened."
          action={
            <Button size="sm" onClick={project.reload}>
              Retry
            </Button>
          }
        >
          {project.error instanceof ApiError
            ? project.error.message
            : 'The server could not be reached. Check your connection and try again.'}
        </Callout>
      </div>
    );
  }

  if (!project.data) return <WorkspaceSkeleton />;

  return <Workspace project={project.data} />;
}

/** The frame's shape while the project loads: toolbar, three columns. */
function WorkspaceSkeleton(): ReactElement {
  return (
    <div
      className="workspace workspace--loading"
      aria-busy="true"
      aria-label="Opening the workspace"
    >
      <div className="ws-toolbar ws-toolbar--skeleton">
        <Skeleton shape="text" width={160} />
        <Skeleton shape="text" width={120} />
        <span className="ws-toolbar__spacer" />
        <Skeleton shape="circle" width={24} height={24} />
      </div>
      <div className="workspace-body workspace-body--loading">
        <Skeleton shape="block" />
        <Skeleton shape="block" />
        <Skeleton shape="block" />
      </div>
      <span className="visually-hidden">Opening the workspace</span>
    </div>
  );
}

/**
 * The workspace once the project is known.
 *
 * Owns everything the panels share: the runtime, the open files, the project
 * event stream, the layout and the `WorkspaceActions` contract the panels
 * call. The runtime lives here rather than inside the toolbar because the
 * console needs the same state: both have to agree about whether anything is
 * running.
 */
function Workspace({ project }: { project: ProjectSummary }): ReactElement {
  const { user } = useAuth();
  const online = useOnline();
  const phone = useIsPhone();
  const runtime = useRuntime(project.id);
  const canWrite = roleCanWrite(project.role);
  const canControl = roleCanControl(project.role);
  const openFiles = useOpenFiles(project.id, canWrite);

  /**
   * Bumped when somebody changes the project's files.
   *
   * A number rather than the change itself: the explorer reloads the tree
   * whenever it moves, exactly as it does after its own edits. An event says
   * what changed, and the panel that cares asks the server what things are
   * now, which keeps one authority on what a project contains.
   */
  const [filesNonce, setFilesNonce] = useState(0);

  /**
   * Bumped when the project stream says the application started or stopped.
   * The console re-reads its state on this one; its own socket already told
   * it about changes it saw itself, so feeding those back would loop.
   */
  const [runStateNonce, setRunStateNonce] = useState(0);
  const bumpRunState = useCallback(() => setRunStateNonce((value) => value + 1), []);

  /** Bumped when the console saw the application change on its own socket. */
  const [consoleNonce, setConsoleNonce] = useState(0);
  const bumpConsoleNonce = useCallback(() => setConsoleNonce((value) => value + 1), []);

  /** Either source: what the preview, the guide strip and the panels follow. */
  const runNonce = runStateNonce + consoleNonce;

  // What the preview reported, which decides the preview column's default
  // width (design spec 9.9).
  const [previewReport, setPreviewReport] = useState<PreviewReport | null>(null);
  const controls = useWorkspaceLayout({
    previewFramed: previewReport?.listening === true && previewReport.framable,
  });

  const status = runtime.state?.runtime?.status;
  const environmentRunning = status === 'RUNNING';
  const appRunning = useAppRunning(project.id, environmentRunning, runNonce);

  /*
   * Which runtime a project needs is read from its files, so a file arriving
   * can change whether it can be started. Only before it is started: a
   * running container was chosen already. Debounced, because saving writes
   * files in bursts and one answer covers the whole burst.
   */
  const refreshRuntime = runtime.refresh;
  useEffect(() => {
    if (filesNonce === 0 || environmentRunning) return;
    const timer = setTimeout(() => void refreshRuntime(), DETECTION_REFRESH_MS);
    return () => clearTimeout(timer);
  }, [filesNonce, environmentRunning, refreshRuntime]);

  const { pathRemoved, pathMoved } = openFiles;
  const onEvent = useCallback(
    (event: ProjectEvent) => {
      switch (event.type) {
        case 'file.removed':
          // Also from somebody else: a tab on a file that is gone says so.
          pathRemoved(event.path);
          setFilesNonce((value) => value + 1);
          return;
        case 'file.moved':
          pathMoved(event.from, event.to);
          setFilesNonce((value) => value + 1);
          return;
        case 'file.written':
        case 'files.replaced':
          setFilesNonce((value) => value + 1);
          return;
        case 'runtime.changed':
          // Somebody else started or stopped it. Read back rather than adopted
          // from the event: the event says a status changed, and the runtime
          // state carries more than a status.
          void runtime.refresh();
          return;
        case 'run.changed':
          // The console's own socket carries this too, but only while the
          // container is up. A program that died with its container is
          // announced here alone.
          bumpRunState();
          return;
        default:
          // Everything else belongs to a page the workspace is not showing.
          return;
      }
    },
    [runtime, bumpRunState, pathRemoved, pathMoved],
  );

  const presence = useProjectEvents(project.id, onEvent);

  // --- the WorkspaceActions contract ---------------------------------------

  const startRef = useRef<HTMLButtonElement>(null);
  const runTarget = useRef<HTMLElement | null>(null);
  const runActions = useRef<RunActions | null>(null);
  const consoleTabSelector = useRef<((tab: ConsoleTab) => void) | null>(null);

  const [shareOpen, setShareOpen] = useState(false);
  // Which part of Share to land on; cleared whenever it closes.
  const [shareSection, setShareSection] = useState<ShareSection | undefined>();
  const onShareOpenChange = useCallback((open: boolean) => {
    setShareOpen(open);
    if (!open) setShareSection(undefined);
  }, []);
  const openShare = useCallback((section?: ShareSection) => {
    setShareSection(section);
    setShareOpen(true);
  }, []);

  const showPanel = controls.show;
  const actions = useMemo<WorkspaceActions>(
    () => ({
      onFilesChanged: () => setFilesNonce((value) => value + 1),
      runNonce,
      focusStart: () => flashElement(startRef.current),
      focusRun: () => flashElement(runTarget.current),
      selectConsoleTab: (tab) => consoleTabSelector.current?.(tab),
      showPanel,
      registerRunTarget: (element) => {
        runTarget.current = element;
      },
      registerRunActions: (next) => {
        runActions.current = next;
      },
      registerConsoleTabSelector: (select) => {
        consoleTabSelector.current = select;
      },
      reportPreview: setPreviewReport,
      openShare,
    }),
    [runNonce, showPanel, openShare],
  );

  // --- dialogs, palette, shortcuts -----------------------------------------

  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [palette, setPalette] = useState<{ open: boolean; mode: 'commands' | 'files' }>({
    open: false,
    mode: 'commands',
  });
  const openPalette = useCallback(
    (mode: 'commands' | 'files' = 'commands') => setPalette({ open: true, mode }),
    [],
  );
  const showShortcuts = useCallback(() => setShortcutsOpen(true), []);

  /*
   * Ctrl/Cmd+Enter runs the app, starting the environment first when it is
   * not up. Each step is the server's: the environment is started, and the
   * run is sent only once the server reports RUNNING.
   */
  const [runWhenReady, setRunWhenReady] = useState(false);
  useEffect(() => {
    if (!runWhenReady) return;
    if (status === 'RUNNING') {
      setRunWhenReady(false);
      void runActions.current?.run();
    } else if (status === 'FAILED' || status === 'STOPPED' || runtime.error) {
      setRunWhenReady(false);
    }
  }, [runWhenReady, status, runtime.error]);

  const runApp = useCallback(() => {
    if (!canControl) return;
    if (environmentRunning) {
      void runActions.current?.run();
      return;
    }
    const state = runtime.state;
    if (!state || !state.provider.available || runtime.busy) return;
    if (!state.detected && !state.runtime) {
      // Nothing to start with yet: the Start button asks which language.
      flashElement(startRef.current);
      return;
    }
    setRunWhenReady(true);
    void runtime.start();
  }, [canControl, environmentRunning, runtime]);

  useWorkspaceShortcuts({
    palette: () => openPalette('commands'),
    quickOpen: () => openPalette('files'),
    run: runApp,
    stopApp: () => void runActions.current?.stop(),
    restartApp: () => void runActions.current?.restart(),
    toggleFiles: () => controls.toggle('files'),
    toggleConsole: () => controls.toggle('console'),
    togglePreview: () => controls.toggle('preview'),
    maximise: controls.toggleMaximise,
    shortcuts: showShortcuts,
    focusTerminal: () => {
      consoleTabSelector.current?.('shell');
      controls.show('console');
      dispatchWorkspaceEvent(WORKSPACE_EVENTS.focusTerminal);
    },
    newTerminal: () => {
      consoleTabSelector.current?.('shell');
      controls.show('console');
      dispatchWorkspaceEvent(WORKSPACE_EVENTS.newTerminal);
    },
    searchFiles: () => {
      controls.show('files');
      dispatchWorkspaceEvent(WORKSPACE_EVENTS.searchFiles);
    },
  });

  const globalCommands = useGlobalCommands({ onShowShortcuts: showShortcuts });
  const commands = useWorkspaceCommands({
    project,
    runtime,
    canControl,
    canWrite,
    environmentRunning,
    appRunning,
    controls,
    runApp,
    runActions,
    onShare: () => openShare(),
    global: globalCommands,
  });

  const files = usePaletteFiles(project.id, palette.open && palette.mode === 'files');

  // --- what the toolbar and strip need -------------------------------------

  const guideStage: GuideStage = !environmentRunning ? 'start' : appRunning ? 'preview' : 'run';
  const previewRegion = useRef<HTMLDivElement>(null);
  const onShowMe = (stage: GuideStage): void => {
    if (stage === 'start') flashElement(startRef.current);
    else if (stage === 'run') {
      controls.show('console');
      flashElement(runTarget.current);
    } else {
      controls.show('preview');
      flashElement(previewRegion.current?.querySelector<HTMLElement>('[aria-label="Preview"]'));
    }
  };

  // A project opened by URL counts as opened, so the list's "Last opened"
  // sort agrees with what the person did.
  useEffect(() => recordProjectOpened(project.id), [project.id]);

  // The checklist's "Open the console" / "Open the preview" links. The panel
  // is shown first; pointing at it waits for the render that puts it on
  // screen, because a collapsed panel only mounts then.
  const [arrivalFocus, setArrivalFocus] = useState<WorkspaceArrivalState['focus']>();
  const openPath = openFiles.openPath;
  useArrivalState(
    useCallback(
      (arrival: WorkspaceArrivalState) => {
        if (arrival.openFile) openPath(arrival.openFile);
        if (arrival.focus) {
          showPanel(arrival.focus);
          setArrivalFocus(arrival.focus);
        }
      },
      [openPath, showPanel],
    ),
  );
  useEffect(() => {
    if (!arrivalFocus) return;
    setArrivalFocus(undefined);
    if (arrivalFocus === 'console') {
      consoleTabSelector.current?.('output');
      flashElement(runTarget.current);
      return;
    }
    const panel = previewRegion.current?.querySelector<HTMLElement>('[aria-label="Preview"]');
    panel?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    flashElement(panel);
  }, [arrivalFocus]);

  // Arriving from a dialog or a link leaves the browser's Tab starting point
  // where that control was, which here lands inside the editor, where Tab
  // indents instead of moving on. Starting from the project's heading puts
  // the next Tab on the toolbar. Only when nothing holds focus, so an arrival
  // target or an open dialog keeps it.
  useEffect(() => {
    if (document.activeElement && document.activeElement !== document.body) return;
    const heading = previewRegion.current?.querySelector<HTMLElement>('h1');
    if (!heading) return;
    heading.tabIndex = -1;
    heading.focus({ preventScroll: true });
  }, [project.id]);

  const activeName = openFiles.activePath?.split('/').pop();
  useDocumentTitle([activeName, project.name], { dirty: openFiles.hasUnsaved });

  const { region, announce } = useLiveRegion();
  useStateAnnouncements(
    announce,
    runtime.state ? statusLabel(runtime.state, false) : undefined,
    status,
    presence.others,
  );

  return (
    <AnnounceContext.Provider value={announce}>
      <WorkspaceActionsContext.Provider value={actions}>
        <div className={`workspace${phone ? ' workspace--phone' : ''}`} ref={previewRegion}>
          <Toolbar
            project={project}
            runtime={runtime}
            presence={presence}
            online={online}
            canControl={canControl}
            appRunning={appRunning}
            startRef={startRef}
            layout={controls}
            phone={phone}
            shareOpen={shareOpen}
            shareSection={shareSection}
            onShareOpenChange={onShareOpenChange}
            onShowShortcuts={showShortcuts}
            onOpenPalette={() => openPalette('commands')}
          />
          {user && canControl ? (
            <GuideStrip
              userId={user.id}
              stage={guideStage}
              framable={previewReport?.framable ?? true}
              phone={phone}
              onShowMe={onShowMe}
            />
          ) : null}
          <WorkspaceLayout
            controls={controls}
            projectId={project.id}
            role={project.role}
            runtime={runtime}
            openFiles={openFiles}
            filesNonce={filesNonce}
            runStateNonce={runStateNonce}
            runNonce={runNonce}
            onRunChange={bumpConsoleNonce}
            onOpenPalette={openPalette}
            phone={phone}
            projectName={project.name}
            previewListening={previewReport?.listening === true}
          />
          {phone ? (
            <PhoneSwitcher
              active={controls.phonePanel}
              onChange={controls.setPhonePanel}
              dirty={openFiles.dirtyCount > 0}
              running={appRunning}
            />
          ) : null}
          {region}
          <CommandPalette
            open={palette.open}
            onOpenChange={(open) => setPalette((current) => ({ ...current, open }))}
            mode={palette.mode}
            commands={commands}
            files={files.files}
            onFileQuery={files.query}
            onOpenFile={openFiles.openPath}
            placeholder="Search commands, settings and files"
          />
          <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
        </div>
      </WorkspaceActionsContext.Provider>
    </AnnounceContext.Provider>
  );
}

/** Where a link into the workspace asked to land (the checklist, the create dialog). */
export interface WorkspaceArrivalState {
  /** A path to open in the editor, such as a starter's entry file. */
  openFile?: string;
  /** A panel to bring forward. */
  focus?: 'console' | 'preview';
}

function readArrival(state: unknown): WorkspaceArrivalState | null {
  if (typeof state !== 'object' || state === null) return null;
  const candidate = state as Record<string, unknown>;
  const arrival: WorkspaceArrivalState = {};
  if (typeof candidate.openFile === 'string' && candidate.openFile) {
    arrival.openFile = candidate.openFile;
  }
  if (candidate.focus === 'console' || candidate.focus === 'preview') {
    arrival.focus = candidate.focus;
  }
  return arrival.openFile || arrival.focus ? arrival : null;
}

/**
 * Acts once on the navigation state a link carried here, then clears it so a
 * reload does not open the file or move the panels again.
 */
function useArrivalState(onArrive: (arrival: WorkspaceArrivalState) => void): void {
  const location = useLocation();
  const navigate = useNavigate();
  // Keyed by the history entry, so StrictMode's second effect run is a no-op.
  const handled = useRef<string | null>(null);

  useEffect(() => {
    if (handled.current === location.key) return;
    handled.current = location.key;
    const arrival = readArrival(location.state);
    if (!arrival) return;
    onArrive(arrival);
    void navigate(
      { pathname: location.pathname, search: location.search, hash: location.hash },
      { replace: true, state: null },
    );
  }, [location, navigate, onArrive]);
}

/** The palette's file search: asked only while the files mode is open. */
function usePaletteFiles(
  projectId: string,
  active: boolean,
): { files: PaletteFiles; query: (text: string) => void } {
  const [text, setText] = useState('');
  const trimmed = text.trim();
  const search = useResource(
    async (signal) => {
      if (!active || trimmed.length < 2) return [];
      const response = await searchFiles(projectId, trimmed, signal);
      return response.results.map((result) => ({ path: result.path }));
    },
    [projectId, active, trimmed],
  );

  const files: PaletteFiles = useMemo(() => {
    if (trimmed.length < 2) return { status: 'idle', items: [] };
    if (search.status === 'error') {
      return {
        status: 'error',
        items: [],
        error: 'The files could not be searched.',
        retry: search.reload,
      };
    }
    if (search.status === 'loading') return { status: 'loading', items: search.data ?? [] };
    return { status: 'ready', items: search.data ?? [] };
  }, [trimmed, search.status, search.data, search.reload]);

  return { files, query: setText };
}

/** One live region for the frame; every announcement in the workspace lands here. */
function useLiveRegion(): { region: ReactElement; announce: Announce } {
  const polite = useRef<HTMLDivElement>(null);
  const assertive = useRef<HTMLDivElement>(null);
  const announce = useCallback<Announce>((message, tone = 'polite') => {
    const target = tone === 'assertive' ? assertive.current : polite.current;
    if (target) writeLiveRegion(target, message);
  }, []);
  const region = (
    <>
      <div
        ref={polite}
        className="visually-hidden"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      />
      <div
        ref={assertive}
        className="visually-hidden"
        role="alert"
        aria-live="assertive"
        aria-atomic="true"
      />
    </>
  );
  return { region, announce };
}

/**
 * Says what changed that the eye would catch: the environment's state word
 * and people arriving or leaving (design spec 9.11).
 */
function useStateAnnouncements(
  announce: Announce,
  label: string | undefined,
  status: RuntimeStatus | undefined,
  others: ReadonlyArray<{ userId: string; displayName: string }>,
): void {
  const previousStatus = useRef<RuntimeStatus | undefined | 'unset'>('unset');
  useEffect(() => {
    if (previousStatus.current === 'unset') {
      previousStatus.current = status;
      return;
    }
    if (previousStatus.current === status) return;
    previousStatus.current = status;
    if (label) announce(`Environment: ${label}`);
  }, [status, label, announce]);

  const known = useRef<Map<string, string> | undefined>(undefined);
  useEffect(() => {
    const next = new Map(others.map((member) => [member.userId, member.displayName]));
    const before = known.current;
    known.current = next;
    // The first roster is where we came in, not a wave of arrivals.
    if (!before) return;
    for (const [id, name] of next) if (!before.has(id)) announce(`${name} joined`);
    for (const [id, name] of before) if (!next.has(id)) announce(`${name} left`);
  }, [others, announce]);
}

/** The palette's workspace entries (design spec 9.12), merged with the shell's. */
function useWorkspaceCommands({
  project,
  runtime,
  canControl,
  canWrite,
  environmentRunning,
  appRunning,
  controls,
  runApp,
  runActions,
  onShare,
  global,
}: {
  project: ProjectSummary;
  runtime: ReturnType<typeof useRuntime>;
  canControl: boolean;
  canWrite: boolean;
  environmentRunning: boolean;
  appRunning: boolean;
  controls: ReturnType<typeof useWorkspaceLayout>;
  runApp: () => void;
  runActions: RefObject<RunActions | null>;
  onShare: () => void;
  global: PaletteCommand[];
}): PaletteCommand[] {
  const { collapsed } = controls.layout;
  const starting =
    runtime.state?.runtime?.status === 'STARTING' ||
    runtime.state?.runtime?.status === 'CREATING' ||
    runtime.state?.runtime?.status === 'REQUESTED';
  const readOnly = canControl ? undefined : 'You have read-only access to this project.';
  const noRunControls = runActions.current ? undefined : 'The console is not ready yet.';

  return useMemo<PaletteCommand[]>(() => {
    const envUp = environmentRunning || starting;
    const panel = (name: WorkspacePanelName, label: string, icon: typeof FolderSimple) => ({
      id: `panel-${name}`,
      label,
      icon,
      group: 'Panels',
      onSelect: () => controls.toggle(name as 'files' | 'console' | 'preview'),
    });
    const commands: PaletteCommand[] = [
      {
        id: 'run-app',
        label: environmentRunning ? 'Run app' : 'Run app (starts the environment first)',
        icon: Play,
        group: 'App',
        shortcut: ['Mod', 'Enter'],
        onSelect: runApp,
        ...(readOnly
          ? { disabledReason: readOnly }
          : appRunning
            ? { disabledReason: 'The app is already running' }
            : {}),
      },
      {
        id: 'stop-app',
        label: 'Stop app',
        icon: Stop,
        group: 'App',
        shortcut: ['Mod', 'Shift', 'Enter'],
        onSelect: () => void runActions.current?.stop(),
        ...(readOnly
          ? { disabledReason: readOnly }
          : !appRunning
            ? { disabledReason: 'The app is not running' }
            : noRunControls
              ? { disabledReason: noRunControls }
              : {}),
      },
      {
        id: 'restart-app',
        label: 'Restart app',
        icon: ArrowClockwise,
        group: 'App',
        shortcut: ['Mod', 'Shift', 'R'],
        onSelect: () => void runActions.current?.restart(),
        ...(readOnly
          ? { disabledReason: readOnly }
          : !appRunning
            ? { disabledReason: 'The app is not running' }
            : noRunControls
              ? { disabledReason: noRunControls }
              : {}),
      },
      {
        id: 'start-env',
        label: 'Start environment',
        icon: Play,
        group: 'Environment',
        onSelect: () => void runtime.start(),
        ...(readOnly
          ? { disabledReason: readOnly }
          : envUp
            ? { disabledReason: 'The environment is already running' }
            : {}),
      },
      {
        id: 'stop-env',
        label: 'Stop environment',
        icon: Stop,
        group: 'Environment',
        onSelect: () => void runtime.stop(),
        ...(readOnly
          ? { disabledReason: readOnly }
          : !envUp
            ? { disabledReason: 'The environment is not running' }
            : {}),
      },
      {
        id: 'new-file',
        label: 'New file',
        icon: FilePlus,
        group: 'Files',
        onSelect: () => {
          controls.show('files');
          dispatchWorkspaceEvent(WORKSPACE_EVENTS.newFile);
        },
        ...(canWrite ? {} : { disabledReason: 'You have read-only access to this project.' }),
      },
      {
        id: 'new-folder',
        label: 'New folder',
        icon: FolderPlus,
        group: 'Files',
        onSelect: () => {
          controls.show('files');
          dispatchWorkspaceEvent(WORKSPACE_EVENTS.newFolder);
        },
        ...(canWrite ? {} : { disabledReason: 'You have read-only access to this project.' }),
      },
      {
        id: 'upload-files',
        label: 'Upload files',
        icon: UploadSimple,
        group: 'Files',
        onSelect: () => {
          controls.show('files');
          dispatchFilesEvent(FILES_EVENTS.upload);
        },
        ...(canWrite ? {} : { disabledReason: 'You have read-only access to this project.' }),
      },
      {
        id: 'sync-files',
        label: 'Sync files',
        icon: ArrowsClockwise,
        group: 'Files',
        keywords: ['read from the environment', 'refresh'],
        onSelect: () => {
          controls.show('files');
          dispatchFilesEvent(FILES_EVENTS.sync);
        },
        ...(!canWrite
          ? { disabledReason: 'You have read-only access to this project.' }
          : !environmentRunning
            ? { disabledReason: 'The environment is not running' }
            : {}),
      },
      panel('files', collapsed.files ? 'Show files' : 'Hide files', FolderSimple),
      panel('console', collapsed.console ? 'Show console' : 'Hide console', TerminalWindow),
      panel('preview', collapsed.preview ? 'Show preview' : 'Hide preview', Browser),
      {
        id: 'maximise',
        label: controls.isMaximised ? 'Restore panels' : 'Maximise editor',
        icon: SidebarSimple,
        group: 'Panels',
        shortcut: ['Ctrl', 'Shift', 'M'],
        onSelect: controls.toggleMaximise,
      },
      {
        id: 'reset-layout',
        label: 'Reset layout',
        icon: SidebarSimple,
        group: 'Panels',
        onSelect: controls.reset,
        ...(controls.isDefault ? { disabledReason: 'Layout is already the default' } : {}),
      },
      {
        id: 'invite',
        label: 'Invite people',
        icon: Users,
        group: 'This project',
        keywords: ['share', 'preview link'],
        onSelect: onShare,
      },
      {
        id: 'editor-settings',
        label: 'Editor settings',
        icon: SlidersHorizontal,
        group: 'Editor',
        onSelect: openEditorSettings,
      },
      {
        id: 'font-up',
        label: 'Editor: increase font size',
        group: 'Editor',
        onSelect: () => adjustEditorFontSize(1),
      },
      {
        id: 'font-down',
        label: 'Editor: decrease font size',
        group: 'Editor',
        onSelect: () => adjustEditorFontSize(-1),
      },
      ...global,
    ];
    return commands;
  }, [
    project.id,
    environmentRunning,
    starting,
    appRunning,
    readOnly,
    noRunControls,
    canWrite,
    collapsed.files,
    collapsed.console,
    collapsed.preview,
    controls,
    runApp,
    runActions,
    runtime,
    onShare,
    global,
  ]);
}
