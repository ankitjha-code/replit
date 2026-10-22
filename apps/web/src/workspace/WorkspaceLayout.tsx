import { useRef, useState, type ReactElement } from 'react';
import { roleHasPermission, type FileEntry, type ProjectRole } from '@platform/shared';
import { canWrite as roleCanWrite } from '../lib/permissions.js';
import { ConsolePanel } from './console/ConsolePanel.js';
import { EditorPanel } from './editor/EditorPanel.js';
import type { OpenFilesState } from './editor/use-open-files.js';
import { FilesPanel } from './files/FilesPanel.js';
import { CollapsedRail, Panel } from './Panel.js';
import { PreviewPanel } from './preview/PreviewPanel.js';
import { PanelErrorBoundary } from './shell/PanelErrorBoundary.js';
import type { WorkspacePanelName } from './shell/workspace-actions.js';
import { Splitter } from './Splitter.js';
import type { LayoutControls } from './use-layout.js';
import type { RuntimeControls } from './use-runtime.js';

/**
 * The workspace's panel arrangement.
 *
 * ```text
 * +---------+-------------------------+-----------+
 * |  Files  |         Editor          |  Preview  |
 * |         +-------------------------+           |
 * |         |         Console         |           |
 * +---------+-------------------------+-----------+
 * ```
 *
 * The console sits under the editor rather than under the whole width, because
 * it belongs to what is being edited and run, while the preview is the result
 * and stays visible beside both.
 *
 * Sizes are CSS grid tracks driven by fractions, so the browser does the
 * arithmetic and nothing has to be recalculated on resize. On a phone the grid
 * gives way to one panel at a time (design spec 9.10): every region stays
 * mounted so terminals and editors survive switching, and only the chosen one
 * is shown.
 */
export function WorkspaceLayout({
  controls,
  projectId,
  role,
  runtime,
  openFiles,
  filesNonce,
  runStateNonce,
  runNonce,
  onRunChange,
  onOpenPalette,
  phone,
  projectName,
  previewListening = false,
}: {
  controls: LayoutControls;
  projectId: string;
  role: ProjectRole;
  runtime: RuntimeControls;
  openFiles: OpenFilesState;
  /** Bumped when somebody changed the files, so the explorer reloads. */
  filesNonce: number;
  /** Bumped when the server says the application changed, so the console reloads. */
  runStateNonce: number;
  /** Bumped when anyone saw the application change, so the preview looks again. */
  runNonce: number;
  /** Told when the console sees the application start or stop. */
  onRunChange: () => void;
  /** Ctrl/Cmd+P from inside the editor. */
  onOpenPalette: (mode: 'files') => void;
  phone: boolean;
  /** For the shell's first line and its accessible name. */
  projectName?: string | undefined;
  /** The preview found something answering on a port. */
  previewListening?: boolean;
}): ReactElement {
  const { layout, setFraction, toggle, phonePanel } = controls;
  const columnsRef = useRef<HTMLDivElement>(null);
  const rowsRef = useRef<HTMLDivElement>(null);

  const canWrite = roleCanWrite(role);
  const running = runtime.state?.runtime?.status === 'RUNNING';

  // What the explorer highlights: the file the editor is showing.
  const [selected, setSelected] = useState<FileEntry | undefined>();

  const shows = (panel: WorkspacePanelName): boolean => !phone || phonePanel === panel;

  const files = (
    <Panel
      title="Files"
      hidden={!shows('files')}
      onCollapse={phone ? undefined : () => toggle('files')}
    >
      <PanelErrorBoundary name="Files">
        <FilesPanel
          projectId={projectId}
          role={role}
          reloadNonce={filesNonce}
          runtimeRunning={running}
          onPathRemoved={openFiles.pathRemoved}
          onPathMoved={openFiles.pathMoved}
          selected={openFiles.activePath ?? selected?.path}
          onSelect={(entry) => {
            setSelected(entry);
            openFiles.open(entry);
            // One panel at a time on a phone: the file just opened would
            // otherwise sit behind the tree with nothing to say it opened.
            if (phone) controls.show('editor');
          }}
        />
      </PanelErrorBoundary>
    </Panel>
  );

  const editor = (
    <Panel title="Editor" id="editor" hidden={!shows('editor')}>
      <PanelErrorBoundary name="Editor">
        <EditorPanel
          files={openFiles}
          role={role}
          projectId={projectId}
          onQuickOpen={() => onOpenPalette('files')}
        />
      </PanelErrorBoundary>
    </Panel>
  );

  const console = (
    <Panel
      title="Console"
      hidden={!shows('console')}
      onCollapse={phone ? undefined : () => toggle('console')}
    >
      <PanelErrorBoundary name="Console">
        <ConsolePanel
          projectId={projectId}
          runtime={runtime.state}
          canControl={canWrite}
          onRunChange={onRunChange}
          runStateNonce={runStateNonce}
          projectName={projectName}
          previewListening={previewListening}
        />
      </PanelErrorBoundary>
    </Panel>
  );

  const preview = (
    <Panel
      title="Preview"
      hidden={!shows('preview')}
      onCollapse={phone ? undefined : () => toggle('preview')}
    >
      <PanelErrorBoundary name="Preview">
        <PreviewPanel
          projectId={projectId}
          runtime={runtime.state}
          runNonce={runNonce}
          // Preview links are the owner's to make; nobody else is offered a dead end.
          canShare={roleHasPermission(role, 'deployment:control')}
        />
      </PanelErrorBoundary>
    </Panel>
  );

  if (phone) {
    // No splitters, no rails: the switcher under the panels chooses, and the
    // stored desktop layout is left alone.
    return (
      <div className="workspace-body workspace-body--phone">
        {files}
        {editor}
        {console}
        {preview}
      </div>
    );
  }

  const filesWidth = layout.collapsed.files ? 'var(--rail-size)' : `${layout.files * 100}%`;
  const previewWidth = layout.collapsed.preview ? 'var(--rail-size)' : `${layout.preview * 100}%`;
  const consoleHeight = layout.collapsed.console ? 'var(--rail-size)' : `${layout.console * 100}%`;

  return (
    <div
      className="workspace-body"
      ref={columnsRef}
      style={{
        // A splitter is only in the flow when the panel beside it is open, so
        // the track list is built to match.
        gridTemplateColumns: [
          filesWidth,
          layout.collapsed.files ? '' : 'var(--splitter-size)',
          'minmax(0, 1fr)',
          layout.collapsed.preview ? '' : 'var(--splitter-size)',
          previewWidth,
        ]
          .filter(Boolean)
          .join(' '),
      }}
    >
      {layout.collapsed.files ? (
        <CollapsedRail title="Files" onExpand={() => toggle('files')} />
      ) : (
        <>
          {files}
          <Splitter
            orientation="vertical"
            side="start"
            fraction={layout.files}
            onChange={(value) => setFraction('files', value)}
            label="Resize the files panel"
            containerRef={columnsRef}
          />
        </>
      )}

      <div
        className="workspace-center"
        ref={rowsRef}
        style={{
          gridTemplateRows: [
            'minmax(0, 1fr)',
            layout.collapsed.console ? '' : 'var(--splitter-size)',
            consoleHeight,
          ]
            .filter(Boolean)
            .join(' '),
        }}
      >
        {editor}

        {layout.collapsed.console ? (
          <CollapsedRail title="Console" horizontal onExpand={() => toggle('console')} />
        ) : (
          <>
            <Splitter
              orientation="horizontal"
              side="end"
              fraction={layout.console}
              onChange={(value) => setFraction('console', value)}
              label="Resize the console panel"
              containerRef={rowsRef}
            />
            {console}
          </>
        )}
      </div>

      {layout.collapsed.preview ? (
        <CollapsedRail title="Preview" onExpand={() => toggle('preview')} />
      ) : (
        <>
          <Splitter
            orientation="vertical"
            side="end"
            fraction={layout.preview}
            onChange={(value) => setFraction('preview', value)}
            label="Resize the preview panel"
            containerRef={columnsRef}
          />
          {preview}
        </>
      )}
    </div>
  );
}
