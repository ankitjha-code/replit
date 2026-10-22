import { Link, useNavigate } from 'react-router-dom';
import type { ProjectSummary } from '@platform/shared';
import { fetchDeployments } from '../../lib/deployments-api.js';
import { canWrite } from '../../lib/permissions.js';
import { useResource } from '../../lib/use-resource.js';
import { useRuntime } from '../../workspace/use-runtime.js';
import { DotsThree, PencilSimple, Trash } from '../../ui/icons.js';
import {
  Button,
  CopyButton,
  IconButton,
  Menu,
  PageHeader,
  StatusPill,
  type MenuItem,
} from '../../ui/index.js';
import { EnvironmentPill } from './EnvironmentPill.js';
import { settingsPath } from './pages.js';

/**
 * Where the page's menu items land on the General page: the element with this
 * id receives focus, so "Rename" puts the cursor in the name field and
 * "Delete project" lands on the button that opens the confirm.
 */
export interface SettingsFocusState {
  focus?: 'project-name' | 'delete-project';
}

/**
 * The header every settings page shares: the project's name as the h1 (a
 * test contract), its URL, what state its environment is in, where it is
 * live, and the way back to the workspace. The breadcrumb is the shell's
 * (`Projects › project › Settings › page` in the site header), not repeated here.
 */
export function SettingsHeader({
  projectId,
  project,
}: {
  projectId: string;
  /** Undefined while loading: the header keeps its shape with skeletons. */
  project: ProjectSummary | undefined;
}): React.JSX.Element {
  const navigate = useNavigate();

  const menuItems: MenuItem[] = [];
  if (project && canWrite(project.role)) {
    menuItems.push({
      label: 'Rename',
      icon: PencilSimple,
      onSelect: () =>
        navigate(settingsPath(projectId, 'general'), {
          state: { focus: 'project-name' } satisfies SettingsFocusState,
        }),
    });
  }
  if (project?.role === 'OWNER') {
    menuItems.push({
      label: 'Delete project',
      icon: Trash,
      tone: 'danger',
      onSelect: () =>
        navigate(settingsPath(projectId, 'general'), {
          state: { focus: 'delete-project' } satisfies SettingsFocusState,
        }),
    });
  }

  return (
    <PageHeader
      className="settings-header"
      aria-busy={project ? undefined : true}
      title={
        project ? (
          project.name
        ) : (
          // A span, not the Skeleton div: an h1 and a p hold phrasing content only.
          <span className="settings-header__placeholder" aria-hidden="true" />
        )
      }
      status={
        project ? (
          <span className="settings-header__pills">
            <HeaderEnvironmentPill projectId={projectId} />
            {project.role === 'OWNER' ? <LiveUrlPill projectId={projectId} /> : null}
          </span>
        ) : null
      }
      description={
        project ? (
          <span className="settings-header__meta">
            <span className="settings-header__slug">
              <code>/{project.slug}</code>
              <CopyButton value={`/${project.slug}`} label="Copy project URL" size="sm" />
            </span>
            {project.description ? <span>{project.description}</span> : null}
          </span>
        ) : undefined
      }
      primaryAction={
        <span className="settings-header__actions">
          <Button variant="secondary" size="lg" asChild>
            <Link to={`/projects/${encodeURIComponent(projectId)}`}>Open workspace</Link>
          </Button>
          {menuItems.length ? (
            <Menu
              trigger={
                <IconButton label="More actions" icon={DotsThree} size="lg" variant="secondary" />
              }
              items={menuItems}
              align="end"
            />
          ) : null}
        </span>
      }
    />
  );
}

function HeaderEnvironmentPill({ projectId }: { projectId: string }): React.JSX.Element {
  const runtime = useRuntime(projectId);
  return <EnvironmentPill state={runtime.state} loading={runtime.loading} />;
}

/**
 * "Live at host" once a deployment is serving. Owner-only, because the
 * deployments endpoint is. A failure to read it is not worth a message in the
 * header: the Deploy page shows the same error with a retry.
 */
function LiveUrlPill({ projectId }: { projectId: string }): React.JSX.Element | null {
  const deployments = useResource((signal) => fetchDeployments(projectId, signal), [projectId]);
  const url = deployments.data?.liveId ? deployments.data.url : null;
  if (!url) return null;
  const host = url.replace(/^https?:\/\//, '');
  return (
    <StatusPill tone="ok">
      <a className="settings-header__pill-link" href={url} target="_blank" rel="noreferrer">
        Live at {host}
      </a>
    </StatusPill>
  );
}
