import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { createProjectRequestSchema, slugify, type ProjectSummary } from '@platform/shared';
import { Field } from '../components/Field.js';
import { useAuth } from '../lib/auth-context.js';
import { fieldErrorsFrom, type FieldErrors } from '../lib/form-errors.js';
import { createProject } from '../lib/projects-api.js';
import { useProjects } from '../lib/use-projects.js';
import { AccountUsage } from './AccountUsage.js';
import '../styles/projects.css';

export function ProjectsPage(): React.JSX.Element {
  const { user } = useAuth();
  const projects = useProjects();
  const [creating, setCreating] = useState(false);

  return (
    <div className="projects">
      <header className="projects__header">
        <div>
          <h1>Your projects</h1>
          <p className="projects__subtitle">
            {user ? `Signed in as ${user.username}` : 'Everything you have built here.'}
          </p>
          {/* Where a ceiling can be acted on. Finding out at the moment Start is
              refused is finding out too late to have planned around it, and the
              project that is full is by definition one of the others. */}
          <AccountUsage />
        </div>
        <button
          type="button"
          className="button-primary button-primary--inline"
          onClick={() => setCreating((open) => !open)}
        >
          {creating ? 'Cancel' : 'New project'}
        </button>
      </header>

      {creating && (
        <NewProjectForm
          onCreated={(project) => {
            projects.add(project);
            setCreating(false);
          }}
        />
      )}

      {projects.status === 'loading' && <p className="projects__note">Loading your projects…</p>}

      {projects.status === 'error' && (
        <div className="projects__error" role="alert">
          <p>{projects.message}</p>
          <button type="button" className="button-quiet" onClick={projects.reload}>
            Try again
          </button>
        </div>
      )}

      {projects.status === 'ready' &&
        (projects.projects.length === 0 ? (
          <EmptyState onStart={() => setCreating(true)} hidden={creating} />
        ) : (
          <ul className="project-grid">
            {projects.projects.map((project) => (
              <li key={project.id}>
                <ProjectCard project={project} />
              </li>
            ))}
          </ul>
        ))}
    </div>
  );
}

function EmptyState({
  onStart,
  hidden,
}: {
  onStart: () => void;
  hidden: boolean;
}): React.JSX.Element | null {
  if (hidden) return null;

  return (
    <div className="projects__empty">
      <h2>Nothing here yet</h2>
      <p>Create your first project to get started.</p>
      {/* Deliberately worded differently from the header button. Two controls
          reading "New project" is ambiguous to anyone navigating by name. */}
      <button type="button" className="button-primary button-primary--inline" onClick={onStart}>
        Create your first project
      </button>
    </div>
  );
}

function ProjectCard({ project }: { project: ProjectSummary }): React.JSX.Element {
  return (
    <Link to={`/projects/${project.id}`} className="project-card">
      <span className="project-card__name">{project.name}</span>
      <span className="project-card__slug">/{project.slug}</span>
      {project.description && (
        <span className="project-card__description">{project.description}</span>
      )}
      <span className="project-card__meta">
        {project.role === 'OWNER' ? 'Owner' : project.role === 'EDITOR' ? 'Editor' : 'Viewer'}
        {' · '}
        {new Date(project.createdAt).toLocaleDateString()}
      </span>
    </Link>
  );
}

function NewProjectForm({
  onCreated,
}: {
  onCreated: (project: ProjectSummary) => void;
}): React.JSX.Element {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [customSlug, setCustomSlug] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | undefined>();
  const [submitting, setSubmitting] = useState(false);

  // The same function the server uses, so what is shown is what will be
  // created. Two implementations would drift and this preview would lie.
  const derived = slugify(name);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setFormError(undefined);

    const candidate = {
      name,
      ...(customSlug && slug ? { slug } : {}),
    };

    const parsed = createProjectRequestSchema.safeParse(candidate);
    if (!parsed.success) {
      const fields: FieldErrors = {};
      for (const issue of parsed.error.issues) {
        const path = issue.path.map(String).join('.');
        if (path && !(path in fields)) fields[path] = issue.message;
      }
      setErrors(fields);
      return;
    }

    setSubmitting(true);
    try {
      onCreated(await createProject(parsed.data));
    } catch (error) {
      const mapped = fieldErrorsFrom(error);
      setErrors(mapped.fields);
      if (mapped.message) setFormError(mapped.message);
      setSubmitting(false);
    }
  }

  return (
    <form className="new-project" onSubmit={submit} noValidate>
      <Field
        id="name"
        label="Project name"
        value={name}
        onChange={(event) => {
          setName(event.target.value);
          setErrors((current) => ({ ...current, name: undefined }));
        }}
        error={errors.name}
        autoFocus
        {...(customSlug || !derived ? {} : { hint: `Its address will be /${derived}` })}
      />

      {customSlug ? (
        <Field
          id="slug"
          label="Address"
          value={slug}
          onChange={(event) => {
            setSlug(event.target.value);
            setErrors((current) => ({ ...current, slug: undefined }));
          }}
          error={errors.slug}
          hint="Lowercase letters, numbers and hyphens."
        />
      ) : (
        <button
          type="button"
          className="link-button"
          onClick={() => {
            setCustomSlug(true);
            setSlug(derived);
          }}
        >
          Choose the address yourself
        </button>
      )}

      {formError && (
        <p className="form-error" role="alert">
          {formError}
        </p>
      )}

      <button type="submit" className="button-primary" disabled={submitting}>
        {submitting ? 'Creating…' : 'Create project'}
      </button>
    </form>
  );
}
