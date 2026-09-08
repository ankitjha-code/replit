import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { ProjectSummary } from '@platform/shared';
import { ApiError } from '../lib/api-client.js';
import { useAuth } from '../lib/auth-context.js';
import { deleteProject, getProject, updateProject } from '../lib/projects-api.js';
import { ProjectAssets } from './ProjectAssets.js';
import { ProjectMembers } from './ProjectMembers.js';
import { ProjectSecrets } from './ProjectSecrets.js';
import { ProjectVariables } from './ProjectVariables.js';
import { ProjectDatabase } from './ProjectDatabase.js';
import { ProjectSnapshots } from './ProjectSnapshots.js';
import { ProjectBranches } from './ProjectBranches.js';
import { ProjectHistory } from './ProjectHistory.js';
import { ProjectDeployments } from './ProjectDeployments.js';
import { ProjectDomains } from './ProjectDomains.js';
import { ProjectPreviewShares } from './ProjectPreviewShares.js';
import { ProjectAlerts } from './ProjectAlerts.js';
import { ProjectLogs } from './ProjectLogs.js';
import { ProjectJobs } from './ProjectJobs.js';
import { ProjectMonitoring } from './ProjectMonitoring.js';
import '../styles/projects.css';

type State =
  | { status: 'loading' }
  | { status: 'ready'; project: ProjectSummary }
  | { status: 'error'; message: string; notFound: boolean };

/**
 * A project's settings.
 *
 * Separate from the workspace because opening a project should put someone in
 * front of their code, not in front of a form. This is where the things you do
 * to a project rather than in it will live.
 */
export function ProjectSettingsPage(): React.JSX.Element {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [state, setState] = useState<State>({ status: 'loading' });
  const [deleting, setDeleting] = useState(false);
  const [confirming, setConfirming] = useState(false);

  /**
   * Bumped when a project's deployment address changes.
   *
   * Two sections show it — deployments says where the project is published, and
   * addresses is where it is changed — so one tells the other rather than
   * either polling or both drifting.
   */
  const [addressNonce, setAddressNonce] = useState(0);
  const [historyNonce, setHistoryNonce] = useState(0);

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
    return <p className="projects__note">Loading…</p>;
  }

  if (state.status === 'error') {
    return (
      <div className="panel">
        {/* The same wording whether it is missing or merely not theirs: the
            server deliberately does not distinguish the two. */}
        <h1>{state.notFound ? 'Not found' : 'Something went wrong'}</h1>
        <p>{state.message}</p>
        <Link to="/">Back to your projects</Link>
      </div>
    );
  }

  const { project } = state;
  const canDelete = project.role === 'OWNER';

  async function confirmDelete(): Promise<void> {
    setDeleting(true);
    try {
      await deleteProject(project.id);
      navigate('/', { replace: true });
    } catch (error) {
      setState({
        status: 'error',
        notFound: false,
        message: error instanceof ApiError ? error.message : 'The project could not be deleted.',
      });
    }
  }

  return (
    <div className="project-detail">
      <header className="project-detail__header">
        <div>
          <h1>{project.name}</h1>
          <p className="project-detail__slug">/{project.slug}</p>
        </div>
        <div className="project-detail__header-actions">
          <Link to={`/projects/${projectId ?? ''}`} className="button-quiet">
            Open workspace
          </Link>
          <Link to="/" className="button-quiet">
            All projects
          </Link>
        </div>
      </header>

      {project.description && <p className="project-detail__description">{project.description}</p>}

      {/* Editors and owners, matching the server's `project:update`. */}
      {project.role !== 'VIEWER' && (
        <RenameProject
          project={project}
          onRenamed={(renamed) => setState({ status: 'ready', project: renamed })}
        />
      )}

      {/* Above everything else a project holds, because who can reach it decides
          who can reach all of it. */}
      <ProjectMembers
        projectId={project.id}
        currentUserId={user?.id}
        canManage={project.role === 'OWNER'}
        // Leaving a project means it is no longer yours to look at, so staying
        // on its settings page would only produce a not-found on the next load.
        onLeft={() => navigate('/', { replace: true })}
      />

      <ProjectAssets projectId={project.id} canWrite={project.role !== 'VIEWER'} />

      {/* Editors and owners, matching the server. Someone trusted to change
          what a project does is trusted to see the port it listens on. */}
      {project.role !== 'VIEWER' && (
        // Writing is passed explicitly rather than derived, because the two
        // capabilities are separate on the server and only happen to be held
        // by the same roles today. Everyone who may read these may edit them.
        <ProjectVariables projectId={project.id} canWrite />
      )}

      {/* A viewer may see that a project's history exists; an editor may add
          to it and remove from it. Matching the server. */}
      <ProjectSnapshots projectId={project.id} canWrite={project.role !== 'VIEWER'} />

      {/* The same capability as snapshots: both are ways of writing down what
          a project was. */}
      <ProjectHistory
        projectId={project.id}
        canWrite={project.role !== 'VIEWER'}
        reloadNonce={historyNonce}
      />

      {/* Owners set the remote because it holds a credential; editors use it. */}
      <ProjectBranches
        projectId={project.id}
        canWrite={project.role !== 'VIEWER'}
        canManageRemote={project.role === 'OWNER'}
        onChanged={() => setHistoryNonce((value) => value + 1)}
      />

      {/* Owners only, matching the server. A deployment serves this project's
          code to people who have no account here and have agreed to nothing,
          which is a decision the person who owns it should make. */}
      {project.role === 'OWNER' && (
        <ProjectDeployments
          projectId={project.id}
          onAddressChanged={() => setAddressNonce((value) => value + 1)}
          addressNonce={addressNonce}
        />
      )}

      {/* Beside deployments, because an address is only meaningful once there
          is something at it. Owners only, matching the server: an address is
          what the outside world knows a project by. */}
      {project.role === 'OWNER' && (
        <ProjectDomains
          projectId={project.id}
          addressNonce={addressNonce}
          onSubdomainChanged={() => setAddressNonce((value) => value + 1)}
        />
      )}

      {/* Owners only, matching the server: showing the running code to people
          with no account is the same decision as deploying it. */}
      {project.role === 'OWNER' && <ProjectPreviewShares projectId={project.id} />}

      {/* What the platform is doing for this project. Above the readings,
          because "it is still building" explains a great deal of what the
          sections below would otherwise show as nothing. */}
      <ProjectJobs projectId={project.id} canControl={project.role !== 'VIEWER'} />

      {/* What the project is using and whether it answers, above its output:
          somebody looking into a problem wants the state before the detail. A
          viewer may read both, because they can already watch the same things
          live in the workspace. */}
      <ProjectMonitoring projectId={project.id} canControl={project.role !== 'VIEWER'} />

      {/* Beside monitoring, which measures what alerts watch. Anyone who can see
          the readings can see whether an alert is firing; only the owner, who
          gets the email, decides whether one is sent. */}
      <ProjectAlerts projectId={project.id} canEdit={project.role === 'OWNER'} />

      {/* A viewer may read a project's output: they can already watch the same
          thing live in the console, so making the stored copy harder to reach
          would be a distinction without a reason. */}
      <ProjectLogs projectId={project.id} />

      {/* Owners only, matching the server. There is nothing useful to show
          about a database without its connection details, and those are a live
          credential. */}
      {project.role === 'OWNER' && <ProjectDatabase projectId={project.id} />}

      {/* Owners only, matching the server. An editor can change what the
          project does and still cannot read or set its credentials. */}
      {project.role === 'OWNER' && <ProjectSecrets projectId={project.id} />}

      <dl className="project-detail__facts">
        <div>
          <dt>Your access</dt>
          <dd>{project.role.charAt(0) + project.role.slice(1).toLowerCase()}</dd>
        </div>
        <div>
          <dt>Created</dt>
          <dd>{new Date(project.createdAt).toLocaleString()}</dd>
        </div>
      </dl>

      {canDelete && (
        <div className="danger-zone">
          <h2>Delete this project</h2>
          <p>This cannot be undone.</p>
          {confirming ? (
            <div className="danger-zone__actions">
              <button
                type="button"
                className="button-danger"
                disabled={deleting}
                onClick={() => void confirmDelete()}
              >
                {deleting ? 'Deleting…' : `Yes, delete ${project.name}`}
              </button>
              <button type="button" className="button-quiet" onClick={() => setConfirming(false)}>
                Keep it
              </button>
            </div>
          ) : (
            <button type="button" className="button-danger" onClick={() => setConfirming(true)}>
              Delete project
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * What a project is called, and what it says about itself.
 *
 * Collapsed until asked for: renaming is something done occasionally, and a
 * form open at the top of every settings page would be the first thing on it.
 * The slug is not offered, and says why — it is in every link already shared.
 */
function RenameProject({
  project,
  onRenamed,
}: {
  project: ProjectSummary;
  onRenamed: (project: ProjectSummary) => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  if (!open) {
    return (
      <div className="project-section__actions">
        <button type="button" className="button-quiet" onClick={() => setOpen(true)}>
          Rename or describe this project
        </button>
      </div>
    );
  }

  return (
    <form
      className="project-section"
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        setError(undefined);

        updateProject(project.id, {
          name: name.trim(),
          description: description.trim() === '' ? null : description.trim(),
        })
          .then((renamed) => {
            onRenamed(renamed);
            setOpen(false);
          })
          .catch((cause: unknown) => {
            setError(
              cause instanceof ApiError ? cause.message : 'The project could not be renamed.',
            );
          })
          .finally(() => setBusy(false));
      }}
    >
      <h2>Name and description</h2>
      <p className="project-section__hint">
        The address stays <code>{project.slug}</code>, because it is in every link that has already
        been shared.
      </p>

      <div className="field">
        <label htmlFor="project-name">Name</label>
        <input
          id="project-name"
          className="input"
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={100}
          required
        />
      </div>

      <div className="field">
        <label htmlFor="project-description">Description</label>
        <input
          id="project-description"
          className="input"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          maxLength={500}
        />
      </div>

      {error && <p className="project-section__error">{error}</p>}

      <div className="project-section__actions">
        <button type="submit" className="button-primary" disabled={busy || name.trim() === ''}>
          {busy ? 'Saving…' : 'Save'}
        </button>
        <button type="button" className="button-quiet" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}
