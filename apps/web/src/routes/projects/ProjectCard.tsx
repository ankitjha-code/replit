import { useState, type ReactElement } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { ProjectSummary } from '@platform/shared';
import { canWrite } from '../../lib/permissions.js';
import { deleteProject } from '../../lib/projects-api.js';
import {
  Badge,
  Card,
  ConfirmDialog,
  IconButton,
  Menu,
  RelativeTime,
  toast,
  type MenuItem,
} from '../../ui/index.js';
import { DotsThree, FolderOpen, Gear, PencilSimple, Trash } from '../../ui/icons.js';
import { settingsPath } from '../settings/pages.js';
import { recordProjectOpened } from './project-prefs.js';

export interface ProjectCardProps {
  project: ProjectSummary;
  /** When this browser last opened it; the card says "Created" otherwise. */
  openedAt?: string;
  onDeleted: (id: string) => void;
}

const ROLE_LABELS: Record<ProjectSummary['role'], string> = {
  OWNER: 'Owner',
  EDITOR: 'Editor',
  VIEWER: 'Viewer',
};

/**
 * One project in the grid. The whole card is one link (its name contains the
 * project name, a test contract) with the overflow menu beside it, outside
 * the link, so a menu is never nested in an anchor.
 */
export function ProjectCard({ project, openedAt, onDeleted }: ProjectCardProps): ReactElement {
  const navigate = useNavigate();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const workspace = `/projects/${project.id}`;

  const items: MenuItem[] = [
    {
      label: 'Open',
      icon: FolderOpen,
      to: workspace,
      onSelect: () => recordProjectOpened(project.id),
    },
    { label: 'Settings', icon: Gear, to: settingsPath(project.id, 'general') },
  ];
  if (canWrite(project.role)) {
    items.push({
      label: 'Rename',
      icon: PencilSimple,
      onSelect: () =>
        void navigate(settingsPath(project.id, 'general'), { state: { focus: 'project-name' } }),
    });
  }
  if (project.role === 'OWNER') {
    items.push({
      label: 'Delete project',
      icon: Trash,
      tone: 'danger',
      onSelect: () => setConfirmDelete(true),
    });
  }

  return (
    <Card as="li" interactive padding="none" className="project-item">
      <Link
        to={workspace}
        className="project-item__link"
        onClick={() => recordProjectOpened(project.id)}
      >
        <span className="project-item__top">
          <span className="project-item__name">{project.name}</span>
          <Badge>{ROLE_LABELS[project.role]}</Badge>
        </span>
        <span className="project-item__slug">/{project.slug}</span>
        {project.description ? (
          <span className="project-item__description">{project.description}</span>
        ) : null}
        <span className="project-item__meta">
          <RelativeTime
            prefix={openedAt ? 'Opened' : 'Created'}
            value={openedAt ?? project.createdAt}
          />
        </span>
      </Link>
      <div className="project-item__actions">
        <Menu
          trigger={<IconButton label={`Actions for ${project.name}`} icon={DotsThree} size="sm" />}
          items={items}
        />
      </div>
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        tone="danger"
        title={`Delete ${project.name}?`}
        body="Its files, environment, database and deployments go with it. This cannot be undone."
        typeToConfirm={project.name}
        confirmLabel={`Yes, delete ${project.name}`}
        onConfirm={async () => {
          await deleteProject(project.id);
          onDeleted(project.id);
          toast({ tone: 'success', title: `Deleted ${project.name}` });
        }}
      />
    </Card>
  );
}
