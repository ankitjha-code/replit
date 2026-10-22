import { useCallback, useMemo, useState, type ReactElement } from 'react';
import { useAuth } from '../lib/auth-context.js';
import type { StarterId } from '../lib/starter-templates.js';
import { useProjects } from '../lib/use-projects.js';
import { GettingStarted } from '../onboarding/GettingStarted.js';
import { VerifyEmailCallout } from '../onboarding/VerifyEmailCallout.js';
import {
  Button,
  Callout,
  EmptyState,
  Input,
  PageHeader,
  SegmentedControl,
  Select,
  Skeleton,
} from '../ui/index.js';
import { ArrowClockwise, FolderSimple, MagnifyingGlass } from '../ui/icons.js';
import { AccountUsage } from './AccountUsage.js';
import { CreateProjectDialog } from './projects/CreateProjectDialog.js';
import { ProjectCard } from './projects/ProjectCard.js';
import { StarterTiles } from './projects/StarterPicker.js';
import { useCreateProjectRequest } from './projects/create-project-request.js';
import {
  SORT_OPTIONS,
  filterProjects,
  readOpened,
  readSort,
  sortProjects,
  writeSort,
  type ProjectFilter,
  type ProjectSort,
} from './projects/project-prefs.js';
import './projects/projects.css';

const SKELETON_CARDS = 6;

const FILTERS: ReadonlyArray<{ value: ProjectFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'mine', label: 'Mine' },
  { value: 'shared', label: 'Shared with me' },
];

export function ProjectsPage(): ReactElement {
  const { user } = useAuth();
  const projects = useProjects();
  const [dialog, setDialog] = useState<{ open: boolean; starter: StarterId }>({
    open: false,
    starter: 'blank',
  });
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<ProjectSort>(() => readSort());
  const [filter, setFilter] = useState<ProjectFilter>('all');
  const opened = useMemo(() => readOpened(), []);

  const openCreate = useCallback((starter: StarterId = 'blank') => {
    setDialog({ open: true, starter });
  }, []);
  useCreateProjectRequest(openCreate);

  const list = projects.status === 'ready' ? projects.projects : [];
  const shown = useMemo(
    () => sortProjects(filterProjects(list, query, filter), sort, opened),
    [list, query, filter, sort, opened],
  );
  const hasProjects = list.length > 0;
  const narrowed = query.trim() !== '' || filter !== 'all';

  return (
    <div className="projects-page page">
      <PageHeader
        title="Your projects"
        primaryAction={
          <Button
            variant={projects.status === 'ready' && !hasProjects ? 'secondary' : 'primary'}
            size="lg"
            onClick={() => openCreate('blank')}
          >
            New project
          </Button>
        }
      />

      <div className="projects-page__body">
        <div className="projects-page__main">
          {user && !user.emailVerified ? <VerifyEmailCallout /> : null}

          {user && projects.status === 'ready' ? (
            <GettingStarted
              user={user}
              projects={projects.projects}
              onCreate={() => openCreate('blank')}
            />
          ) : null}

          {projects.status === 'loading' ? (
            <ul className="projects-grid" aria-busy="true" aria-label="Loading your projects">
              {Array.from({ length: SKELETON_CARDS }, (_, index) => (
                <li key={index}>
                  <Skeleton shape="card" height={132} />
                </li>
              ))}
            </ul>
          ) : null}

          {projects.status === 'error' ? (
            <Callout
              tone="danger"
              title={projects.message}
              action={
                <Button size="sm" icon={ArrowClockwise} onClick={projects.reload}>
                  Try again
                </Button>
              }
            />
          ) : null}

          {projects.status === 'ready' && !hasProjects ? (
            <>
              <EmptyState
                size="page"
                icon={FolderSimple}
                title="Nothing here yet"
                body="A project is your code, an environment to run it in, and a preview to share."
                action={
                  <Button variant="primary" size="lg" onClick={() => openCreate('blank')}>
                    Create your first project
                  </Button>
                }
              />
              <StarterTiles onPick={openCreate} />
            </>
          ) : null}

          {projects.status === 'ready' && hasProjects ? (
            <>
              <div className="projects-page__toolbar" role="search">
                <Input
                  type="search"
                  size="md"
                  aria-label="Search projects"
                  placeholder="Search by name or URL"
                  leading={<MagnifyingGlass size={16} aria-hidden="true" />}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  className="projects-page__search"
                />
                <Select
                  size="md"
                  aria-label="Sort by"
                  value={sort}
                  options={SORT_OPTIONS.map((option) => ({
                    value: option.value,
                    label: option.label,
                  }))}
                  onValueChange={(value) => {
                    const next = value as ProjectSort;
                    setSort(next);
                    writeSort(next);
                  }}
                  className="projects-page__sort"
                />
                <SegmentedControl
                  label="Show"
                  size="md"
                  value={filter}
                  onValueChange={(value) => setFilter(value as ProjectFilter)}
                  items={FILTERS.map((option) => ({
                    value: option.value,
                    label: option.label,
                  }))}
                />
                {narrowed ? (
                  <p className="projects-page__count" role="status">
                    {shown.length} of {list.length}
                  </p>
                ) : null}
              </div>

              {shown.length === 0 ? (
                <EmptyState
                  icon={MagnifyingGlass}
                  title={
                    query.trim()
                      ? `No projects match "${query.trim()}".`
                      : filter === 'mine'
                        ? 'None of these projects are yours.'
                        : 'No one has shared a project with you.'
                  }
                  action={
                    <Button
                      onClick={() => {
                        setQuery('');
                        setFilter('all');
                      }}
                    >
                      {query.trim() ? 'Clear search' : 'Show all'}
                    </Button>
                  }
                />
              ) : (
                <ul className="projects-grid">
                  {shown.map((project) => (
                    <ProjectCard
                      key={project.id}
                      project={project}
                      {...(opened[project.id] ? { openedAt: opened[project.id] } : {})}
                      onDeleted={projects.remove}
                    />
                  ))}
                </ul>
              )}
            </>
          ) : null}
        </div>

        <aside className="projects-page__aside">
          <AccountUsage />
        </aside>
      </div>

      <CreateProjectDialog
        open={dialog.open}
        onOpenChange={(open) => setDialog((current) => ({ ...current, open }))}
        starter={dialog.starter}
        onCreated={projects.add}
      />
    </div>
  );
}
