import { useCallback, useEffect, useRef, useState } from 'react';
import type { FileEntry, ProjectRole } from '@platform/shared';
import { EditorPanel } from './editor/EditorPanel.js';
import { useOpenFiles } from './editor/use-open-files.js';
import { FilesPanel } from './files/FilesPanel.js';
import { Panel } from './Panel.js';
import { PreviewPanel } from './preview/PreviewPanel.js';
import { ConsolePanel } from './console/ConsolePanel.js';
import type { ProjectPresence } from './use-project-events.js';
import type { RuntimeControls } from './use-runtime.js';
import { Splitter } from './Splitter.js';
import type { LayoutControls } from './use-layout.js';

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
 * arithmetic and nothing has to be recalculated on resize.
 */
export function WorkspaceLayout({
  controls,
  projectId,
  role,
  runtime,
  presence,
  filesNonce,
}: {
  controls: LayoutControls;
  projectId: string;
  role: ProjectRole;
  runtime: RuntimeControls;
  presence: ProjectPresence;
  /** Bumped when somebody else changed the files, so the explorer reloads. */
  filesNonce: number;
}): React.JSX.Element {
  const { layout, setFraction, toggle } = controls;
  const columnsRef = useRef<HTMLDivElement>(null);
  const rowsRef = useRef<HTMLDivElement>(null);

  const canWrite = role === 'OWNER' || role === 'EDITOR';
  const openFiles = useOpenFiles(projectId, canWrite);

  // What the explorer highlights: the file the editor is showing.
  const [selected, setSelected] = useState<FileEntry | undefined>();

  /**
   * Bumped whenever the application starts or stops.
   *
   * The preview follows the program rather than the container, so it is told
   * at the moment that changes instead of finding out on its next poll.
   */
  const [runNonce, setRunNonce] = useState(0);
  const onRunChange = useCallback(() => setRunNonce((value) => value + 1), []);

  /*
   * What this window is looking at, told to everybody else in the project.
   *
   * Sent from here because this is where the open files live. Best effort by
   * design: it is the file the editor has focused, which is a good guess at
   * where somebody's attention is and not a claim about it.
   */
  useEffect(() => {
    presence.setFile(openFiles.activePath ?? null);
  }, [presence, openFiles.activePath]);

  const filesWidth = layout.collapsed.files ? '0px' : `${layout.files * 100}%`;
  const previewWidth = layout.collapsed.preview ? '0px' : `${layout.preview * 100}%`;
  const consoleHeight = layout.collapsed.console ? '0px' : `${layout.console * 100}%`;

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
        <CollapsedRail label="Files" onExpand={() => toggle('files')} />
      ) : (
        <>
          <Panel
            title="Files"
            actions={<PanelToggle label="Hide files" onClick={() => toggle('files')} />}
          >
            <FilesPanel
              projectId={projectId}
              role={role}
              reloadNonce={filesNonce}
              runtimeRunning={runtime.state?.runtime?.status === 'RUNNING'}
              selected={openFiles.activePath ?? selected?.path}
              onSelect={(entry) => {
                setSelected(entry);
                openFiles.open(entry);
              }}
            />
          </Panel>
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
        <Panel title="Editor">
          <EditorPanel files={openFiles} role={role} projectId={projectId} />
        </Panel>

        {layout.collapsed.console ? (
          <CollapsedRail label="Console" horizontal onExpand={() => toggle('console')} />
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
            <Panel
              title="Console"
              actions={<PanelToggle label="Hide console" onClick={() => toggle('console')} />}
            >
              <ConsolePanel
                projectId={projectId}
                runtime={runtime.state}
                canControl={canWrite}
                onRunChange={onRunChange}
              />
            </Panel>
          </>
        )}
      </div>

      {layout.collapsed.preview ? (
        <CollapsedRail label="Preview" onExpand={() => toggle('preview')} />
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
          <Panel
            title="Preview"
            actions={<PanelToggle label="Hide preview" onClick={() => toggle('preview')} />}
          >
            <PreviewPanel projectId={projectId} runtime={runtime.state} runNonce={runNonce} />
          </Panel>
        </>
      )}
    </div>
  );
}

function PanelToggle({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}): React.JSX.Element {
  return (
    <button type="button" className="panel-frame__toggle" onClick={onClick} title={label}>
      <span className="visually-hidden">{label}</span>
      <span aria-hidden="true">×</span>
    </button>
  );
}

/**
 * A hidden panel's way back.
 *
 * A collapsed panel keeps a visible edge rather than disappearing entirely,
 * so nothing is lost with no way to bring it back.
 */
function CollapsedRail({
  label,
  onExpand,
  horizontal = false,
}: {
  label: string;
  onExpand: () => void;
  horizontal?: boolean;
}): React.JSX.Element {
  return (
    <button
      type="button"
      className={`collapsed-rail${horizontal ? ' collapsed-rail--horizontal' : ''}`}
      onClick={onExpand}
    >
      Show {label.toLowerCase()}
    </button>
  );
}
