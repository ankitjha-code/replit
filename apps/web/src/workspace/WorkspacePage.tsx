import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { ProjectEvent, ProjectSummary } from '@platform/shared';
import { ApiError } from '../lib/api-client.js';
import { getProject } from '../lib/projects-api.js';
import { PresenceBar } from './PresenceBar.js';
import { RuntimeControls } from './RuntimeControls.js';
import { WorkspaceLayout } from './WorkspaceLayout.js';
import { useWorkspaceLayout } from './use-layout.js';
import { useProjectEvents, type ProjectPresence } from './use-project-events.js';
import { useRuntime, type RuntimeControls as RuntimeState } from './use-runtime.js';
import '../styles/workspace.css';

type State =
  | { status: 'loading' }
  | { status: 'ready'; project: ProjectSummary }
  | { status: 'error'; message: string; notFound: boolean };

/**
 * A project's workspace.
 *
 * The shell: a toolbar, and the regions the editor, terminal and preview will
 * occupy. Everything inside says plainly that it is not built rather than
 * imitating the thing that will be there.
 */
export function WorkspacePage(): React.JSX.Element {
  const { projectId } = useParams<{ projectId: string }>();
  const [state, setState] = useState<State>({ status: 'loading' });
  const controls = useWorkspaceLayout();

  useEffect(() => {
    if (!projectId) return;
    const controller = new AbortController();

    getProject(projectId, controller.signal)
      .then((project) => setState({ status: 'ready', project }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        const notFound = error instanceof ApiError && error.code === 'NOT_FOUND';
        setState({
          status: 'error',
          notFound,
          message: notFound
            ? 'That project does not exist, or you do not have access to it.'
            : error instanceof ApiError
              ? error.message
              : 'The project could not be loaded.',
        });
      });

    return () => controller.abort();
  }, [projectId]);

  if (state.status === 'loading') {
    return <div className="workspace workspace--message">Opening the workspace…</div>;
  }

  if (state.status === 'error') {
    return (
      <div className="workspace workspace--message">
        <div className="panel">
          {/* The same wording whether it is missing or merely not theirs: the
              server deliberately does not distinguish the two. */}
          <h1>{state.notFound ? 'Not found' : 'Something went wrong'}</h1>
          <p>{state.message}</p>
          <Link to="/">Back to your projects</Link>
        </div>
      </div>
    );
  }

  return <Workspace project={state.project} controls={controls} />;
}

/**
 * The workspace once the project is known.
 *
 * Separate so the runtime can be loaded with a hook, which a component with
 * early returns cannot do. The runtime lives here rather than inside the
 * toolbar because the console needs the same state: both have to agree about
 * whether anything is running.
 */
function Workspace({
  project,
  controls,
}: {
  project: ProjectSummary;
  controls: ReturnType<typeof useWorkspaceLayout>;
}): React.JSX.Element {
  const runtime = useRuntime(project.id);
  const canWrite = project.role === 'OWNER' || project.role === 'EDITOR';

  /**
   * Bumped when somebody changes the project's files.
   *
   * A number rather than the change itself: the explorer reloads the tree
   * whenever it moves, exactly as it does after its own edits. An event says
   * what changed, and the panel that cares asks the server what things are
   * now — which keeps one authority on what a project contains.
   */
  const [filesNonce, setFilesNonce] = useState(0);

  const onEvent = useCallback(
    (event: ProjectEvent) => {
      switch (event.type) {
        case 'file.written':
        case 'file.removed':
        case 'file.moved':
        case 'files.replaced':
          setFilesNonce((value) => value + 1);
          return;
        case 'runtime.changed':
          // Somebody else started or stopped it. Read back rather than adopted
          // from the event: the event says a status changed, and the runtime
          // state carries more than a status.
          void runtime.refresh();
          return;
        default:
          /*
           * Everything else belongs to a page the workspace is not showing.
           *
           * Run state already arrives on the console's own socket, and
           * snapshots, history and configuration live in settings. Reacting
           * here would be reacting on behalf of something not on screen.
           */
          return;
      }
    },
    [runtime],
  );

  const presence = useProjectEvents(project.id, onEvent);

  return (
    <div className="workspace">
      <WorkspaceToolbar
        project={project}
        runtime={runtime}
        presence={presence}
        canControl={canWrite}
        onResetLayout={controls.reset}
      />
      <WorkspaceLayout
        controls={controls}
        projectId={project.id}
        role={project.role}
        runtime={runtime}
        presence={presence}
        filesNonce={filesNonce}
      />
    </div>
  );
}

function WorkspaceToolbar({
  project,
  runtime,
  presence,
  canControl,
  onResetLayout,
}: {
  project: ProjectSummary;
  runtime: RuntimeState;
  presence: ProjectPresence;
  canControl: boolean;
  onResetLayout: () => void;
}): React.JSX.Element {
  return (
    <header className="workspace-toolbar">
      {/* The arrow is decoration. Without the label the link announces as
          "left arrow", which tells a screen reader nothing about where it
          goes. */}
      <Link to="/" className="workspace-toolbar__back">
        <span aria-hidden="true">&#8592;</span>
        <span className="visually-hidden">All projects</span>
      </Link>

      <div className="workspace-toolbar__identity">
        <span className="workspace-toolbar__name">{project.name}</span>
        <span className="workspace-toolbar__slug">/{project.slug}</span>
      </div>

      {/* The real runtime state, read from the server. It says "not running",
          "starting", "failed" or "unavailable" as the case may be, and never
          a hopeful "Ready". */}
      <RuntimeControls runtime={runtime} canControl={canControl} />

      {/* Only ever other people, and only while the stream is live. */}
      <PresenceBar others={presence.others} connected={presence.connected} />

      <div className="workspace-toolbar__actions">
        <button type="button" className="button-quiet" onClick={onResetLayout}>
          Reset layout
        </button>
        <Link to={`/projects/${project.id}/settings`} className="button-quiet">
          Settings
        </Link>
      </div>
    </header>
  );
}
