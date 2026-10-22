import { useEffect, useState } from 'react';
import { Navigate, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import type { ProjectSummary } from '@platform/shared';
import { ApiError } from '../lib/api-client.js';
import { useAuth } from '../lib/auth-context.js';
import { getProject } from '../lib/projects-api.js';
import { useResource } from '../lib/use-resource.js';
import { Button, Callout, Skeleton } from '../ui/index.js';
import { NotFoundPage } from './NotFoundPage.js';
import { AssetsPage } from './settings/AssetsPage.js';
import { DatabasePage } from './settings/DatabasePage.js';
import { DeployPage } from './settings/DeployPage.js';
import { EnvironmentPage } from './settings/EnvironmentPage.js';
import { GeneralPage } from './settings/GeneralPage.js';
import { GitPage } from './settings/GitPage.js';
import { HistoryPage } from './settings/HistoryPage.js';
import { LogsPage } from './settings/LogsPage.js';
import { MonitoringPage } from './settings/MonitoringPage.js';
import { PeoplePage } from './settings/PeoplePage.js';
import { SettingsLayout } from './settings/SettingsLayout.js';

/**
 * A project's settings: the things you do to a project rather than in it.
 *
 * Separate from the workspace because opening a project should put someone in
 * front of their code, not in front of a form. The pages are nested routes
 * under `settings/*`; this component owns them so the shell declares one
 * route and never changes when a page is added.
 */
export function ProjectSettingsPage(): React.JSX.Element {
  const { projectId = '' } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const loaded = useResource((signal) => getProject(projectId, signal), [projectId]);

  // A rename answers with the whole project; it replaces what was read until
  // the next read, so the header and the form agree without a refetch.
  const [renamed, setRenamed] = useState<ProjectSummary | undefined>();
  useEffect(() => setRenamed(undefined), [loaded.data]);
  const project = renamed ?? loaded.data;

  if (loaded.error && !project) {
    // The same page whether it is missing or merely not theirs: the server
    // deliberately does not distinguish the two.
    if (loaded.error instanceof ApiError && loaded.error.code === 'NOT_FOUND') {
      return <NotFoundPage />;
    }
    return (
      <SettingsLayout projectId={projectId} project={undefined}>
        <Callout
          tone="danger"
          title={
            loaded.error instanceof ApiError
              ? loaded.error.message
              : 'The project could not be loaded.'
          }
          action={
            <Button size="sm" onClick={loaded.reload}>
              Retry
            </Button>
          }
        />
      </SettingsLayout>
    );
  }

  if (!project) {
    return (
      <SettingsLayout projectId={projectId} project={undefined}>
        <div className="settings-page-skeleton">
          <Skeleton height={28} width="40%" />
          <Skeleton shape="row" />
          <Skeleton shape="row" />
          <Skeleton shape="row" />
        </div>
      </SettingsLayout>
    );
  }

  const leave = (): void => {
    void navigate('/', { replace: true });
  };

  return (
    <SettingsLayout projectId={projectId} project={project}>
      <Routes>
        <Route index element={<Navigate to="general" replace />} />
        <Route
          path="general"
          element={
            <GeneralPage project={project} onProjectChanged={setRenamed} onDeleted={leave} />
          }
        />
        <Route
          path="people"
          element={<PeoplePage project={project} currentUserId={user?.id} onLeft={leave} />}
        />
        <Route path="environment" element={<EnvironmentPage project={project} />} />
        <Route path="database" element={<DatabasePage project={project} />} />
        <Route path="assets" element={<AssetsPage project={project} />} />
        <Route path="deploy" element={<DeployPage project={project} />} />
        <Route path="history" element={<HistoryPage project={project} />} />
        <Route path="git" element={<GitPage project={project} />} />
        <Route path="monitoring" element={<MonitoringPage project={project} />} />
        <Route path="logs" element={<LogsPage project={project} />} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </SettingsLayout>
  );
}
