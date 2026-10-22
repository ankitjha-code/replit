import { useEffect, useState, type FormEvent } from 'react';
import { useLocation } from 'react-router-dom';
import type { ProjectSummary } from '@platform/shared';
import { Field } from '../../components/Field.js';
import { ApiError } from '../../lib/api-client.js';
import { canWrite } from '../../lib/permissions.js';
import { deleteProject, updateProject } from '../../lib/projects-api.js';
import { useAction } from '../../lib/use-action.js';
import { announceProjectRenamed } from '../../shell/project-renamed.js';
import {
  Button,
  Callout,
  Card,
  ConfirmDialog,
  CopyButton,
  Input,
  KeyValue,
  RelativeTime,
  SectionHeader,
  toast,
} from '../../ui/index.js';
import { InPageNav } from './InPageNav.js';
import { OwnerOnlyCallout } from './OwnerOnlyCallout.js';
import type { SettingsFocusState } from './SettingsHeader.js';
import { SettingsSection } from './SettingsSection.js';

const SECTIONS = [
  { id: 'general-name', label: 'Name and description' },
  { id: 'general-about', label: 'About' },
  { id: 'general-danger', label: 'Danger zone' },
];

const ROLE_WORDS: Record<ProjectSummary['role'], string> = {
  OWNER: 'Owner',
  EDITOR: 'Editor',
  VIEWER: 'Viewer',
};

export function GeneralPage({
  project,
  onProjectChanged,
  onDeleted,
}: {
  project: ProjectSummary;
  onProjectChanged: (project: ProjectSummary) => void;
  onDeleted: () => void;
}): React.JSX.Element {
  const location = useLocation();
  const [confirming, setConfirming] = useState(false);

  const focus = (location.state as SettingsFocusState | null)?.focus;
  useEffect(() => {
    if (focus) document.getElementById(focus)?.focus();
  }, [focus]);

  const isOwner = project.role === 'OWNER';

  return (
    <>
      <InPageNav items={SECTIONS} />

      <SettingsSection id="general-name">
        <SectionHeader
          title="Name and description"
          description="The URL stays the same after a rename, because it is in every link already shared."
        />
        <RenameForm project={project} onProjectChanged={onProjectChanged} />
      </SettingsSection>

      <SettingsSection id="general-about">
        <SectionHeader title="About" />
        <KeyValue
          items={[
            { term: 'Created', value: <RelativeTime value={project.createdAt} /> },
            { term: 'Your access', value: ROLE_WORDS[project.role] },
            { term: 'Project id', value: project.id, mono: true, copy: project.id },
          ]}
        />
      </SettingsSection>

      <SettingsSection id="general-danger">
        <SectionHeader title="Danger zone" />
        {isOwner ? (
          <Card tone="danger" padding="md" className="settings-danger">
            <h3 className="settings-danger__title">Delete this project</h3>
            <p className="settings-danger__text">
              Its files, environment, deployments and history are removed with it. This cannot be
              undone.
            </p>
            <div className="settings-danger__actions">
              <Button id="delete-project" variant="danger" onClick={() => setConfirming(true)}>
                Delete project
              </Button>
            </div>
            <ConfirmDialog
              open={confirming}
              onOpenChange={setConfirming}
              tone="danger"
              title={`Delete ${project.name}?`}
              body="Its files, environment, deployments and history are removed with it. This cannot be undone."
              typeToConfirm={project.name}
              confirmLabel={`Yes, delete ${project.name}`}
              onConfirm={async () => {
                await deleteProject(project.id);
                onDeleted();
              }}
            />
          </Card>
        ) : (
          <OwnerOnlyCallout projectId={project.id} what="delete this project" />
        )}
      </SettingsSection>
    </>
  );
}

function RenameForm({
  project,
  onProjectChanged,
}: {
  project: ProjectSummary;
  onProjectChanged: (project: ProjectSummary) => void;
}): React.JSX.Element {
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description ?? '');
  const [nameError, setNameError] = useState<string | undefined>();
  const editable = canWrite(project.role);
  const save = useAction(() =>
    updateProject(project.id, {
      name: name.trim(),
      description: description.trim() === '' ? null : description.trim(),
    }),
  );

  const unchanged =
    name.trim() === project.name && (description.trim() || null) === (project.description ?? null);
  const readOnlyReason = editable
    ? undefined
    : 'Only editors and the owner can rename this project';

  const onSubmit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (name.trim() === '') {
      setNameError('Enter a name');
      return;
    }
    setNameError(undefined);
    const outcome = await save.run();
    if (outcome.ok) {
      onProjectChanged(outcome.value);
      announceProjectRenamed(outcome.value);
      toast({ tone: 'success', title: 'Saved' });
    }
  };

  return (
    <form className="settings-form" onSubmit={(event) => void onSubmit(event)} noValidate>
      <Field
        id="project-name"
        label="Name"
        value={name}
        onChange={(event) => {
          setName(event.target.value);
          if (nameError) setNameError(undefined);
          if (save.error) save.reset();
        }}
        maxLength={100}
        required
        error={nameError}
        {...(readOnlyReason ? { disabledReason: readOnlyReason } : {})}
      />
      <Field
        id="project-description"
        label="Description"
        value={description}
        onChange={(event) => setDescription(event.target.value)}
        maxLength={500}
        hint="Shown on the projects list. Optional."
        {...(readOnlyReason ? { disabledReason: readOnlyReason } : {})}
      />
      <Field id="project-url" label="Project URL" hint="Opens at this path. It cannot be changed.">
        <Input
          id="project-url"
          value={`/${project.slug}`}
          readOnly
          mono
          trailing={<CopyButton value={`/${project.slug}`} label="Copy project URL" size="sm" />}
        />
      </Field>
      {save.error ? (
        <Callout
          tone="danger"
          title={
            save.error instanceof ApiError
              ? save.error.message
              : 'The project could not be renamed.'
          }
        />
      ) : null}
      <div className="settings-form__actions">
        <Button
          type="submit"
          variant="primary"
          loading={save.busy}
          {...(readOnlyReason
            ? { disabledReason: readOnlyReason }
            : unchanged
              ? { disabledReason: 'Nothing has changed yet' }
              : {})}
        >
          Save
        </Button>
      </div>
    </form>
  );
}
