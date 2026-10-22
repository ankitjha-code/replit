import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from 'react';
import { roleHasPermission, type ProjectRole } from '@platform/shared';
import { useAnnounce } from '../../lib/announce.js';
import { fetchFileContent } from '../../lib/files-api.js';
import { Badge } from '../../ui/Badge/Badge.js';
import { Button } from '../../ui/Button/Button.js';
import { Callout } from '../../ui/Callout/Callout.js';
import { CopyButton } from '../../ui/CopyButton/CopyButton.js';
import { EmptyState } from '../../ui/EmptyState/EmptyState.js';
import { IconButton } from '../../ui/IconButton/IconButton.js';
import { ContextMenu } from '../../ui/Menu/ContextMenu.js';
import { Menu } from '../../ui/Menu/Menu.js';
import type { MenuGroup } from '../../ui/Menu/menu-items.js';
import { Skeleton } from '../../ui/Skeleton/Skeleton.js';
import { toast } from '../../ui/Toast/Toast.js';
import { Tooltip } from '../../ui/Tooltip/Tooltip.js';
import {
  CheckCircle,
  Circle,
  CircleNotch,
  Code,
  DownloadSimple,
  File,
  Image,
  ListDashes,
  Lock,
  SlidersHorizontal,
  Trash,
  Warning,
  WifiSlash,
  X,
  type Icon,
} from '../../ui/icons.js';
import { isApplePlatform } from '../../ui/internal/platform.js';
import { CloseGuardDialog, type CloseGuardReason } from './CloseGuardDialog.js';
import type { CursorPosition } from './CodeEditor.js';
import { CompareDialog } from './CompareDialog.js';
import { EditorSettingsDialog } from './EditorSettingsDialog.js';
import { EDITOR_SETTINGS_OPEN_EVENT, useEditorSettings } from './editor-settings.js';
import { useDocumentSession, type DocumentSessionState } from './use-document-session.js';
import { isDirty, type OpenFile, type OpenFilesState } from './use-open-files.js';
import './editor.css';

const CodeEditor = lazy(() => import('./CodeEditor.js'));

export interface EditorPanelProps {
  files: OpenFilesState;
  role: ProjectRole;
  projectId: string;
  onQuickOpen?: (() => void) | undefined;
  onRevealInFiles?: ((path: string) => void) | undefined;
}

function closeGuardReason(file: OpenFile): CloseGuardReason | undefined {
  if (file.deleted) return 'deleted';
  if (file.saveState === 'conflict') return 'conflict';
  if (file.saveState === 'blocked') return 'blocked';
  return isDirty(file) ? 'dirty' : undefined;
}

export function EditorPanel({
  files,
  role,
  projectId,
  onQuickOpen,
  onRevealInFiles,
}: EditorPanelProps): React.JSX.Element {
  const canWrite = roleHasPermission(role, 'file:write');
  const { active } = files;
  const baseId = useId();
  const tabId = (path: string): string => `${baseId}-tab-${encodeURIComponent(path)}`;
  const panelId = `${baseId}-panel`;

  const [closing, setClosing] = useState<string | undefined>();
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    const open = (): void => setSettingsOpen(true);
    document.addEventListener(EDITOR_SETTINGS_OPEN_EVENT, open);
    return () => document.removeEventListener(EDITOR_SETTINGS_OPEN_EVENT, open);
  }, []);

  useEffect(() => {
    if (!files.hasUnsaved) return;

    const onBeforeUnload = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
    };

    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [files.hasUnsaved]);

  const requestClose = useCallback(
    (path: string) => {
      const file = files.files.find((candidate) => candidate.path === path);
      if (!file) return;
      if (closeGuardReason(file)) setClosing(path);
      else files.close(path);
    },
    [files],
  );

  const closeClean = useCallback(
    (paths: string[]) => {
      const kept: string[] = [];
      for (const path of paths) {
        const file = files.files.find((candidate) => candidate.path === path);
        if (!file) continue;
        if (closeGuardReason(file)) kept.push(file.name);
        else files.close(path);
      }
      if (kept.length > 0) {
        toast({
          tone: 'info',
          title: kept.length === 1 ? `Kept ${kept[0]!}` : `Kept ${String(kept.length)} tabs`,
          description: 'Tabs with unsaved changes stay open until you decide about them.',
        });
      }
    },
    [files],
  );

  const cycle = (step: number): void => {
    const count = files.files.length;
    if (count < 2 || !files.activePath) return;
    const index = files.files.findIndex((file) => file.path === files.activePath);
    files.activate(files.files[(index + step + count) % count]!.path);
  };

  const onPanelKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!(event.ctrlKey || event.metaKey)) return;
    const key = event.key.toLowerCase();
    if (key === 's' && !event.shiftKey) {
      event.preventDefault();
      void files.saveActive();
      return;
    }
    if (key === 'w' && !event.shiftKey && files.activePath) {
      event.preventDefault();
      requestClose(files.activePath);
      return;
    }
    if (event.key === 'Tab' || event.key === 'PageDown' || event.key === 'PageUp') {
      event.preventDefault();
      cycle(event.key === 'PageUp' || event.shiftKey ? -1 : 1);
    }
  };

  const quickOpen = (): void => {
    if (onQuickOpen) {
      onQuickOpen();
      return;
    }
    const apple = isApplePlatform();
    document.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'p',
        code: 'KeyP',
        ctrlKey: !apple,
        metaKey: apple,
        bubbles: true,
        cancelable: true,
      }),
    );
  };

  const closingFile = closing
    ? files.files.find((candidate) => candidate.path === closing)
    : undefined;

  if (files.files.length === 0) {
    return (
      <div className="editor-pane editor-pane--empty">
        <EmptyState
          icon={Code}
          title="Nothing open"
          body="Pick a file on the left, or press Ctrl+P to open one by name."
          action={
            <Button variant="secondary" onClick={quickOpen}>
              Open file…
            </Button>
          }
        />
        <EditorSettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
      </div>
    );
  }

  return (
    <div className="editor-pane" onKeyDown={onPanelKeyDown}>
      <TabStrip
        files={files}
        tabId={tabId}
        panelId={panelId}
        onClose={requestClose}
        onCloseOthers={(path) =>
          closeClean(files.files.filter((file) => file.path !== path).map((file) => file.path))
        }
        onCloseSaved={() => closeClean(files.files.map((file) => file.path))}
        onRevealInFiles={onRevealInFiles}
      />
      <div
        className="editor-tabpanel"
        role="tabpanel"
        id={panelId}
        aria-labelledby={active ? tabId(active.path) : undefined}
      >
        {active && (
          <ActiveFile
            file={active}
            files={files}
            canWrite={canWrite}
            projectId={projectId}
            onOpenSettings={() => setSettingsOpen(true)}
            onClose={requestClose}
          />
        )}
      </div>

      {closingFile && (
        <CloseGuardDialog
          open
          fileName={closingFile.name}
          reason={closeGuardReason(closingFile) ?? 'dirty'}
          onSaveAndClose={async () => {
            await files.flush(closingFile.path);
            files.close(closingFile.path);
            setClosing(undefined);
          }}
          onDiscard={() => {
            files.close(closingFile.path);
            setClosing(undefined);
          }}
          onCancel={() => setClosing(undefined)}
        />
      )}
      <EditorSettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </div>
  );
}

function TabStrip({
  files,
  tabId,
  panelId,
  onClose,
  onCloseOthers,
  onCloseSaved,
  onRevealInFiles,
}: {
  files: OpenFilesState;
  tabId: (path: string) => string;
  panelId: string;
  onClose: (path: string) => void;
  onCloseOthers: (path: string) => void;
  onCloseSaved: () => void;
  onRevealInFiles: ((path: string) => void) | undefined;
}): React.JSX.Element {
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!files.activePath) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-path="${CSS.escape(files.activePath)}"]`)
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [files.activePath]);

  return (
    <div className="editor-tabs">
      <div className="editor-tabs__list" role="tablist" aria-label="Open files" ref={listRef}>
        {files.files.map((file) => (
          <Tab
            key={file.path}
            file={file}
            files={files}
            id={tabId(file.path)}
            panelId={panelId}
            onClose={onClose}
            onCloseOthers={onCloseOthers}
            onCloseSaved={onCloseSaved}
            onRevealInFiles={onRevealInFiles}
          />
        ))}
      </div>
      {files.files.length > 1 && (
        <div className="editor-tabs__overflow">
          <Menu
            trigger={<IconButton label="List open files" icon={ListDashes} size="sm" />}
            align="end"
            items={files.files.map((file) => ({
              id: file.path,
              label: closeGuardReason(file) ? `${file.name} (unsaved)` : file.name,
              checked: file.path === files.activePath,
              onSelect: () => files.activate(file.path),
            }))}
          />
        </div>
      )}
    </div>
  );
}

function Tab({
  file,
  files,
  id,
  panelId,
  onClose,
  onCloseOthers,
  onCloseSaved,
  onRevealInFiles,
}: {
  file: OpenFile;
  files: OpenFilesState;
  id: string;
  panelId: string;
  onClose: (path: string) => void;
  onCloseOthers: (path: string) => void;
  onCloseSaved: () => void;
  onRevealInFiles: ((path: string) => void) | undefined;
}): React.JSX.Element {
  const unsafe = closeGuardReason(file) !== undefined;
  const selected = files.activePath === file.path;

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    const index = files.files.findIndex((candidate) => candidate.path === file.path);
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      files.activate(files.files[(index + 1) % files.files.length]!.path);
    }
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      files.activate(files.files[(index - 1 + files.files.length) % files.files.length]!.path);
    }
    if (event.key === 'Home') {
      event.preventDefault();
      files.activate(files.files[0]!.path);
    }
    if (event.key === 'End') {
      event.preventDefault();
      files.activate(files.files[files.files.length - 1]!.path);
    }
    if (event.key === 'Delete') {
      event.preventDefault();
      onClose(file.path);
    }
  };

  const onAuxClick = (event: MouseEvent<HTMLDivElement>): void => {
    if (event.button !== 1) return;
    event.preventDefault();
    onClose(file.path);
  };

  const menu: MenuGroup[] = [
    {
      items: [
        { label: 'Close', shortcut: ['Mod', 'W'], onSelect: () => onClose(file.path) },
        {
          label: 'Close others',
          ...(files.files.length < 2 ? { disabledReason: 'No other tabs are open' } : {}),
          onSelect: () => onCloseOthers(file.path),
        },
        { label: 'Close saved', onSelect: onCloseSaved },
      ],
    },
    {
      items: [
        {
          label: 'Copy path',
          onSelect: () => {
            void import('../../lib/clipboard.js').then(({ copyText }) =>
              copyText(file.path).then((ok) => {
                if (!ok) {
                  toast({
                    tone: 'danger',
                    title: 'Could not copy',
                    description: 'Select the path in the status bar and copy it by hand.',
                  });
                }
              }),
            );
          },
        },
        ...(onRevealInFiles
          ? [{ label: 'Reveal in Files', onSelect: () => onRevealInFiles(file.path) }]
          : []),
      ],
    },
  ];

  return (
    <div
      className={`editor-tab${selected ? ' editor-tab--active' : ''}${
        unsafe ? ' editor-tab--unsaved' : ''
      }${file.deleted ? ' editor-tab--deleted' : ''}`}
      data-path={file.path}
      onAuxClick={onAuxClick}
    >
      <ContextMenu groups={menu} label={`Actions for ${file.name}`}>
        <button
          type="button"
          role="tab"
          id={id}
          aria-selected={selected}
          aria-controls={panelId}
          tabIndex={selected ? 0 : -1}
          className="editor-tab__button"
          onClick={() => files.activate(file.path)}
          onKeyDown={onKeyDown}
          title={file.deleted ? `${file.path} (deleted)` : file.path}
        >
          <span className="editor-tab__name">{file.name}</span>
        </button>
      </ContextMenu>
      <IconButton
        size="sm"
        className="editor-tab__close"
        label={unsafe ? `Close ${file.name}, unsaved` : `Close ${file.name}`}
        tabIndex={selected ? 0 : -1}
        icon={
          unsafe ? (
            <span className="editor-tab__mark" aria-hidden="true">
              <Circle size={10} weight="fill" className="editor-tab__dot" />
              <X size={14} className="editor-tab__x" />
            </span>
          ) : (
            X
          )
        }
        onClick={() => onClose(file.path)}
      />
    </div>
  );
}

function ActiveFile({
  file,
  files,
  canWrite,
  projectId,
  onOpenSettings,
  onClose,
}: {
  file: OpenFile;
  files: OpenFilesState;
  canWrite: boolean;
  projectId: string;
  onOpenSettings: () => void;
  onClose: (path: string) => void;
}): React.JSX.Element {
  const session = useDocumentSession(projectId, file.path, file.status === 'ready');
  const shared = session.status.state === 'ready' || session.status.state === 'reconnecting';

  useEffect(() => {
    files.setShared(file.path, shared);
  }, [files, file.path, shared]);

  const [cursor, setCursor] = useState<CursorPosition>({ line: 1, column: 1 });
  const [compareOpen, setCompareOpen] = useState(false);
  const [unavailableDismissed, setUnavailableDismissed] = useState<string | undefined>();

  if (file.status === 'loading') {
    return <EditorSkeleton label={`Opening ${file.name}`} />;
  }

  if (file.status === 'error') {
    return (
      <EmptyState
        icon={Warning}
        title={file.name}
        body={file.message ?? 'This file could not be opened.'}
        action={
          <Button variant="secondary" onClick={() => files.reload(file.path)}>
            Try again
          </Button>
        }
      />
    );
  }

  if (file.status === 'unopenable') {
    return <UnopenableFile file={file} projectId={projectId} />;
  }

  const unavailable =
    session.status.state === 'unavailable' && unavailableDismissed !== file.path
      ? session.status.reason
      : undefined;

  return (
    <>
      <div className="editor-messages">
        {file.deleted ? (
          <DeletedBar file={file} files={files} canWrite={canWrite} onClose={onClose} />
        ) : file.saveState === 'conflict' && file.conflict ? (
          <ConflictBar file={file} files={files} onCompare={() => setCompareOpen(true)} />
        ) : (
          file.saveState === 'blocked' &&
          file.message && <Callout tone="danger">{file.message}</Callout>
        )}

        {session.stale && (
          <Callout
            tone="warn"
            title="No longer being saved"
            action={
              <Button size="sm" variant="secondary" onClick={session.reconnect}>
                Reconnect
              </Button>
            }
          >
            {session.stale}
          </Callout>
        )}

        {unavailable && (
          <Callout
            tone="warn"
            title="Live editing is unavailable for this file; changes still save."
            action={
              <Button size="sm" variant="secondary" onClick={session.reconnect}>
                Reconnect
              </Button>
            }
            onDismiss={() => setUnavailableDismissed(file.path)}
          >
            {unavailable}
          </Callout>
        )}
      </div>

      <div className="editor-surface">
        <Suspense fallback={<EditorSkeleton label="Loading the editor" />}>
          <CodeEditor
            path={file.path}
            language={file.language}
            value={file.content}
            revision={file.revision}
            readOnly={
              !canWrite || (shared && session.status.state === 'ready' && !session.status.canWrite)
            }
            sharedText={shared ? session.text : undefined}
            awareness={shared ? session.awareness : undefined}
            onChange={(value) => files.change(file.path, value)}
            onSave={() => void files.save(file.path)}
            onCursorChange={setCursor}
          />
        </Suspense>
      </div>

      <StatusBar
        file={file}
        files={files}
        canWrite={canWrite}
        session={session}
        cursor={cursor}
        onOpenSettings={onOpenSettings}
      />

      {file.conflict && (
        <CompareDialog
          open={compareOpen}
          onOpenChange={setCompareOpen}
          fileName={file.name}
          language={file.language}
          theirs={file.conflict.theirContent}
          mine={file.content}
          onKeepMine={() => {
            setCompareOpen(false);
            void files.keepMine(file.path);
          }}
          onUseTheirs={() => {
            setCompareOpen(false);
            files.useTheirs(file.path);
          }}
        />
      )}
    </>
  );
}

function EditorSkeleton({ label }: { label: string }): React.JSX.Element {
  return (
    <div className="editor-skeleton" role="status" aria-busy="true" aria-label={label}>
      {Array.from({ length: 12 }, (_, index) => (
        <Skeleton key={index} className="editor-skeleton__line" />
      ))}
    </div>
  );
}

const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
};

function imageType(path: string): string | undefined {
  const extension = path.split('.').pop()?.toLowerCase() ?? '';
  return IMAGE_TYPES[extension];
}

function UnopenableFile({ file, projectId }: { file: OpenFile; projectId: string }) {
  const mime = imageType(file.path);
  const [preview, setPreview] = useState<string | undefined>();
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    if (!mime) return;
    const controller = new AbortController();
    fetchFileContent(projectId, file.path, controller.signal)
      .then((response) => {
        if (response.encoding === 'base64') setPreview(`data:${mime};base64,${response.content}`);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [projectId, file.path, mime]);

  const download = async (): Promise<void> => {
    setDownloading(true);
    try {
      const response = await fetchFileContent(projectId, file.path);
      const bytes =
        response.encoding === 'base64'
          ? Uint8Array.from(atob(response.content), (character) => character.charCodeAt(0))
          : new TextEncoder().encode(response.content);
      const url = URL.createObjectURL(new Blob([bytes]));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = file.name;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      toast({
        tone: 'danger',
        title: 'Could not download',
        description: error instanceof Error ? error.message : 'The file could not be read.',
      });
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="editor-unopenable">
      {preview && <img className="editor-unopenable__image" src={preview} alt={file.name} />}
      <EmptyState
        icon={mime ? Image : File}
        title={file.name}
        body={file.message ?? 'This file cannot be opened in the editor.'}
        action={
          <Button
            variant="secondary"
            icon={DownloadSimple}
            loading={downloading}
            onClick={() => void download()}
          >
            Download
          </Button>
        }
      />
    </div>
  );
}

function ConflictBar({
  file,
  files,
  onCompare,
}: {
  file: OpenFile;
  files: OpenFilesState;
  onCompare: () => void;
}): React.JSX.Element {
  return (
    <Callout
      tone="warn"
      role="alert"
      className="editor-conflict-bar"
      action={
        <>
          <Button size="sm" variant="secondary" onClick={() => void files.keepMine(file.path)}>
            Keep mine
          </Button>
          <Button size="sm" variant="secondary" onClick={() => files.useTheirs(file.path)}>
            Use theirs
          </Button>
          <Button size="sm" variant="ghost" onClick={onCompare}>
            Compare
          </Button>
        </>
      }
    >
      <strong>{file.name}</strong> changed elsewhere while you were editing. Your text is still
      here. Choose which version to keep.
    </Callout>
  );
}

function DeletedBar({
  file,
  files,
  canWrite,
  onClose,
}: {
  file: OpenFile;
  files: OpenFilesState;
  canWrite: boolean;
  onClose: (path: string) => void;
}): React.JSX.Element {
  const saving = file.saveState === 'saving';
  return (
    <Callout
      tone="warn"
      role="alert"
      title={`${file.name} was deleted`}
      className="editor-deleted-bar"
      action={
        <>
          {canWrite ? (
            <Button
              size="sm"
              variant="secondary"
              loading={saving}
              onClick={() => void files.save(file.path)}
            >
              Save as new file
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" disabled={saving} onClick={() => onClose(file.path)}>
            Close
          </Button>
        </>
      }
    >
      {file.message ?? 'Your unsaved text is still here, and nothing saves it until you choose.'}
    </Callout>
  );
}

export function saveLabel(file: OpenFile, online: boolean): string {
  if (file.deleted) return file.saveState === 'saving' ? 'Saving…' : 'Deleted';
  switch (file.saveState) {
    case 'saving':
      return 'Saving…';
    case 'pending':
      return 'Unsaved changes';
    case 'retrying':
      return online ? 'Could not save. Retrying…' : 'Offline. Will save when reconnected';
    case 'conflict':
      return 'Changed elsewhere';
    case 'blocked':
      return 'Not saved';
    case 'idle':
    default:
      return isDirty(file) ? 'Unsaved changes' : 'Saved';
  }
}

export function sharedLabel(session: DocumentSessionState): string {
  if (session.stale) return 'Not being saved';
  if (session.status.state === 'reconnecting') return 'Reconnecting. Your changes are kept';
  if (session.status.state === 'ready' && !session.status.canWrite) return 'Read only';
  return 'Saved';
}

type StateTone = 'ok' | 'pending' | 'busy' | 'warn' | 'danger' | 'muted';

function stateStyle(label: string, online: boolean): { icon: Icon; tone: StateTone } {
  switch (label) {
    case 'Saved':
      return { icon: CheckCircle, tone: 'ok' };
    case 'Saving…':
      return { icon: CircleNotch, tone: 'busy' };
    case 'Unsaved changes':
      return { icon: Circle, tone: 'pending' };
    case 'Not saved':
    case 'Changed elsewhere':
    case 'Not being saved':
      return { icon: Warning, tone: 'danger' };
    case 'Deleted':
      return { icon: Trash, tone: 'danger' };
    case 'Read only':
      return { icon: Lock, tone: 'muted' };
    default:
      return { icon: online ? Warning : WifiSlash, tone: 'warn' };
  }
}

const LANGUAGE_NAMES: Record<string, string> = {
  javascript: 'JavaScript',
  typescript: 'TypeScript',
  json: 'JSON',
  html: 'HTML',
  css: 'CSS',
  scss: 'SCSS',
  less: 'Less',
  markdown: 'Markdown',
  python: 'Python',
  go: 'Go',
  ruby: 'Ruby',
  shell: 'Shell',
  yaml: 'YAML',
  xml: 'XML',
  sql: 'SQL',
  dockerfile: 'Dockerfile',
  plaintext: 'Plain text',
};

function languageName(id: string): string {
  return LANGUAGE_NAMES[id] ?? id.charAt(0).toUpperCase() + id.slice(1);
}

function useAnnounceSettled(message: string, delay: number): void {
  const announce = useAnnounce();
  const previous = useRef(message);
  useEffect(() => {
    if (previous.current === message) return;
    const timer = setTimeout(() => {
      previous.current = message;
      announce(message);
    }, delay);
    return () => clearTimeout(timer);
  }, [message, delay, announce]);
}

function StatusBar({
  file,
  files,
  canWrite,
  session,
  cursor,
  onOpenSettings,
}: {
  file: OpenFile;
  files: OpenFilesState;
  canWrite: boolean;
  session: DocumentSessionState;
  cursor: CursorPosition;
  onOpenSettings: () => void;
}): React.JSX.Element {
  const dirty = isDirty(file);
  const busy = file.saveState === 'saving';
  const shared = session.status.state === 'ready' || session.status.state === 'reconnecting';
  const settings = useEditorSettings();

  const others = Math.max(session.participants.length - 1, 0);
  const names = session.participants.map((person) => person.displayName || person.username);

  const label = !canWrite
    ? 'Read only'
    : shared
      ? sharedLabel(session)
      : saveLabel(file, files.online);
  const { icon: StateIcon, tone } = stateStyle(label, files.online);
  useAnnounceSettled(`${label}: ${file.name}`, 1_000);

  const saveReason = !dirty
    ? 'Nothing to save'
    : shared
      ? 'The platform saves this file as you type'
      : file.saveState === 'conflict'
        ? 'Choose which version to keep first'
        : undefined;

  return (
    <div className="editor-statusbar">
      <span className="editor-statusbar__path" title={file.path}>
        {file.path}
      </span>
      <CopyButton value={file.path} label="Copy path" className="editor-statusbar__copy" />
      <span className="editor-statusbar__spacer" />

      <span className="editor-statusbar__item editor-statusbar__item--wide">
        Ln {cursor.line}, Col {cursor.column}
      </span>
      <span className="editor-statusbar__item editor-statusbar__item--wide">
        Spaces: {settings.tabSize}
      </span>
      <span className="editor-statusbar__item editor-statusbar__item--wide">
        {languageName(file.language)}
      </span>

      {shared && others > 0 && (
        <Tooltip content={`In this file: ${names.join(', ')}`}>
          <Badge tone="ok" dot>
            Live with {others}
          </Badge>
        </Tooltip>
      )}

      <span className={`editor-statusbar__state editor-statusbar__state--${tone}`}>
        <StateIcon size={12} className="editor-statusbar__state-icon" aria-hidden="true" />
        {label}
      </span>

      {canWrite && (
        <Button
          size="sm"
          variant="ghost"
          className="editor-statusbar__save"
          loading={busy}
          loadingLabel="Saving"
          {...(saveReason && !busy ? { disabledReason: saveReason } : {})}
          onClick={() => void files.save(file.path)}
        >
          Save now
        </Button>
      )}

      <IconButton
        size="sm"
        label="Editor settings"
        icon={SlidersHorizontal}
        onClick={onOpenSettings}
      />
    </div>
  );
}
