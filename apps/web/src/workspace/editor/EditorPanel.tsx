import { Suspense, lazy, useEffect, type KeyboardEvent } from 'react';
import { roleHasPermission, type ProjectRole } from '@platform/shared';
import { PanelPlaceholder } from '../Panel.js';
import { useDocumentSession, type DocumentSessionState } from './use-document-session.js';
import { isDirty, type OpenFile, type OpenFilesState } from './use-open-files.js';

/**
 * Monaco is several megabytes, so it is fetched only when a file is actually
 * opened. Someone who signs in to look at their project list never pays for it.
 */
const CodeEditor = lazy(() => import('./CodeEditor.js'));

export interface EditorPanelProps {
  files: OpenFilesState;
  role: ProjectRole;
  projectId: string;
}

export function EditorPanel({ files, role, projectId }: EditorPanelProps): React.JSX.Element {
  const canWrite = roleHasPermission(role, 'file:write');
  const { active } = files;

  // Ctrl+S with focus outside the editor. Monaco binds the same combination
  // internally for when focus is inside it.
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void files.saveActive();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [files]);

  /*
   * The browser's own warning before leaving with unsaved work. It is the only
   * thing that can interrupt a closed tab or a typed URL, and losing someone's
   * code to a stray keystroke is the worst failure this surface has.
   */
  useEffect(() => {
    if (!files.hasUnsaved) return;

    const onBeforeUnload = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
    };

    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [files.hasUnsaved]);

  if (files.files.length === 0) {
    return (
      <PanelPlaceholder
        headline="Nothing open"
        detail="Choose a file in the explorer to open it here."
      />
    );
  }

  return (
    <div className="editor-panel">
      <TabStrip files={files} />
      <div className="editor-panel__body">
        {active && (
          <ActiveFile file={active} files={files} canWrite={canWrite} projectId={projectId} />
        )}
      </div>
    </div>
  );
}

function TabStrip({ files }: { files: OpenFilesState }): React.JSX.Element {
  return (
    <div className="tab-strip" role="tablist" aria-label="Open files">
      {files.files.map((file) => (
        <Tab key={file.path} file={file} files={files} />
      ))}
    </div>
  );
}

function Tab({ file, files }: { file: OpenFile; files: OpenFilesState }): React.JSX.Element {
  // The marker means "not safely stored yet", which is broader than dirty: a
  // conflict or a stalled retry is also work that is not on the server.
  const unsafe = isDirty(file) || file.saveState === 'conflict' || file.saveState === 'blocked';
  const selected = files.activePath === file.path;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const index = files.files.findIndex((candidate) => candidate.path === file.path);
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      files.activate(files.files[(index + 1) % files.files.length]!.path);
    }
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      files.activate(files.files[(index - 1 + files.files.length) % files.files.length]!.path);
    }
  };

  return (
    <div
      role="tab"
      aria-selected={selected}
      // Only the selected tab is a tab stop, so moving past the strip takes
      // one press rather than one per open file.
      tabIndex={selected ? 0 : -1}
      className={`tab${selected ? ' tab--active' : ''}`}
      onClick={() => files.activate(file.path)}
      onKeyDown={onKeyDown}
      title={file.path}
    >
      <span className="tab__name">{file.name}</span>

      {/*
        The dot and the close control occupy the same place: a tab that shows
        both is wider than its neighbours and the strip jitters as you type.
      */}
      <button
        type="button"
        className="tab__close"
        aria-label={unsafe ? `Close ${file.name}, unsaved` : `Close ${file.name}`}
        onClick={(event) => {
          event.stopPropagation();
          files.close(file.path);
        }}
      >
        <span aria-hidden="true">{unsafe ? '●' : '×'}</span>
      </button>
    </div>
  );
}

function ActiveFile({
  file,
  files,
  canWrite,
  projectId,
}: {
  file: OpenFile;
  files: OpenFilesState;
  canWrite: boolean;
  projectId: string;
}): React.JSX.Element {
  /*
   * The shared document for this file, if the platform can provide one.
   *
   * Opened for every file that opens successfully, not only when somebody else
   * is here. A session that engaged on somebody else's arrival would have to
   * take over a buffer mid-edit, which is the one moment it must not get wrong.
   *
   * Only ever for a file that loaded: a binary or oversized file has no text to
   * share, and asking for one would be asking the server a question it has
   * already answered.
   */
  const session = useDocumentSession(projectId, file.path, file.status === 'ready');
  const shared = session.status.state === 'ready' || session.status.state === 'reconnecting';

  /*
   * While a file is shared, the editor's own saving stands down.
   *
   * The platform writes the document back, so a second writer here would mean
   * two savers racing on one path and conflicting with each other. Told rather
   * than inferred, because `useOpenFiles` cannot see this socket.
   */
  useEffect(() => {
    files.setShared(file.path, shared);
  }, [files, file.path, shared]);

  if (file.status === 'loading') {
    return <p className="editor-panel__note">Opening {file.name}…</p>;
  }

  if (file.status === 'error' || file.status === 'unopenable') {
    return (
      <PanelPlaceholder
        headline={file.name}
        detail={file.message ?? 'This file could not be opened.'}
      />
    );
  }

  return (
    <>
      {file.saveState === 'conflict' && file.conflict ? (
        <ConflictBar file={file} files={files} />
      ) : (
        file.message && (
          <p className="editor-panel__message" role="alert">
            {file.message}
          </p>
        )
      )}

      {/* The one thing about a shared session a person must be told: it has
          stopped being written down. */}
      {session.stale && (
        <p className="editor-panel__message" role="alert">
          {session.stale}
        </p>
      )}

      <div className="editor-panel__editor">
        <Suspense fallback={<p className="editor-panel__note">Loading the editor…</p>}>
          <CodeEditor
            path={file.path}
            language={file.language}
            value={file.content}
            revision={file.revision}
            // The server's answer wins over the role this client was told: a
            // viewer typing into a buffer whose changes are discarded is worse
            // served than one shown a read-only editor.
            readOnly={
              !canWrite || (shared && session.status.state === 'ready' && !session.status.canWrite)
            }
            sharedText={shared ? session.text : undefined}
            awareness={shared ? session.awareness : undefined}
            onChange={(value) => files.change(file.path, value)}
            onSave={() => void files.save(file.path)}
          />
        </Suspense>
      </div>

      <StatusBar file={file} files={files} canWrite={canWrite} session={session} />
    </>
  );
}

/**
 * A conflict, presented as a decision.
 *
 * Both options are explicit and neither is default. The one thing this must
 * never do is pick for the person: whichever it chose, the other version would
 * be gone.
 */
function ConflictBar({
  file,
  files,
}: {
  file: OpenFile;
  files: OpenFilesState;
}): React.JSX.Element {
  return (
    <div className="editor-conflict" role="alert">
      <p className="editor-conflict__text">
        <strong>{file.name}</strong> changed elsewhere while you were editing. Your text is still
        here. Choose which version to keep.
      </p>
      <div className="editor-conflict__actions">
        <button
          type="button"
          className="icon-button"
          onClick={() => void files.keepMine(file.path)}
        >
          Keep mine
        </button>
        <button type="button" className="icon-button" onClick={() => files.useTheirs(file.path)}>
          Use theirs
        </button>
      </div>
    </div>
  );
}

/** What the status line says, given where the buffer stands with the server. */
export function saveLabel(file: OpenFile, online: boolean): string {
  switch (file.saveState) {
    case 'saving':
      return 'Saving…';
    case 'pending':
      return 'Unsaved changes';
    case 'retrying':
      // Offline is the cause a person can act on, so it is named rather than
      // hidden behind a generic retry message.
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

function StatusBar({
  file,
  files,
  canWrite,
  session,
}: {
  file: OpenFile;
  files: OpenFilesState;
  canWrite: boolean;
  session: DocumentSessionState;
}): React.JSX.Element {
  const dirty = isDirty(file);
  const busy = file.saveState === 'saving';
  const shared = session.status.state === 'ready' || session.status.state === 'reconnecting';

  /*
   * Other people in this file, never this window's own account.
   *
   * The platform does not tell a client which participant it is, so this counts
   * everybody and subtracts one: the roster always contains the reader. Shown
   * only when there is somebody else, because "1 person here" is noise.
   */
  const others = Math.max(session.participants.length - 1, 0);

  return (
    <div className="editor-status">
      <span className="editor-status__path">{file.path}</span>
      <span className="editor-status__spacer" />

      {shared && others > 0 && (
        <span className="editor-status__state">
          {others === 1 ? '1 other person editing' : `${others} other people editing`}
        </span>
      )}

      {!canWrite && <span className="editor-status__state">Read only</span>}

      {canWrite && (
        <>
          <span
            className={`editor-status__state${
              file.saveState === 'retrying' ||
              file.saveState === 'blocked' ||
              session.stale !== undefined
                ? ' editor-status__state--warning'
                : ''
            }`}
          >
            {shared ? sharedLabel(session) : saveLabel(file, files.online)}
          </span>
          <button
            type="button"
            className="icon-button"
            // Nothing for this button to do while the platform is saving the
            // document: there is no separate copy here to write.
            disabled={shared || !dirty || busy}
            onClick={() => void files.save(file.path)}
          >
            Save now
          </button>
        </>
      )}
    </div>
  );
}

/** What the status line says while a file is being edited collaboratively. */
function sharedLabel(session: DocumentSessionState): string {
  if (session.stale) return 'Not being saved';
  if (session.status.state === 'reconnecting') return 'Reconnecting. Your changes are kept';
  if (session.status.state === 'ready' && !session.status.canWrite) return 'Read only';
  return session.savedAt ? 'Shared, saved' : 'Shared';
}
