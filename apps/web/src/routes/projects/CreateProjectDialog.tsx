import { useEffect, useRef, useState, type FormEvent, type ReactElement } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  RESERVED_PROJECT_SLUGS,
  createProjectRequestSchema,
  projectSlugSchema,
  slugify,
  type ProjectSummary,
} from '@platform/shared';
import { Field } from '../../components/Field.js';
import { writeFile } from '../../lib/files-api.js';
import { fieldErrorsFrom, type FieldErrors } from '../../lib/form-errors.js';
import { createProject } from '../../lib/projects-api.js';
import { setRunCommand } from '../../lib/runtime-api.js';
import { findStarter, type StarterId, type StarterTemplate } from '../../lib/starter-templates.js';
import { useAction } from '../../lib/use-action.js';
import { Button, Callout, Dialog, Input, Progress } from '../../ui/index.js';
import { StarterPicker } from './StarterPicker.js';

export interface CreateProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The template the dialog opens on. */
  starter?: StarterId;
  /** The project exists on the server; the list inserts its card. */
  onCreated: (project: ProjectSummary) => void;
}

/** What the browser is doing after the project exists. */
type Phase =
  | { kind: 'form' }
  | {
      kind: 'writing';
      project: ProjectSummary;
      template: StarterTemplate;
      step: number;
      total: number;
    }
  | {
      kind: 'failed';
      project: ProjectSummary;
      template: StarterTemplate;
      step: number;
      total: number;
      message: string;
    };

/** The shared schema speaks of slugs; the UI calls them URLs. */
function slugMessage(slug: string): string {
  if (RESERVED_PROJECT_SLUGS.has(slug)) return 'That URL is reserved by the platform.';
  return 'Use 1 to 63 lowercase letters, numbers and single hyphens.';
}

/**
 * Where the slug message lands: the server's conflict details say `slug`,
 * and so do the shared schema's issues.
 */
function mapFieldErrors(fields: FieldErrors, slug: string): FieldErrors {
  if (!fields.slug) return fields;
  const serverConflict = /already have a project/i.test(fields.slug);
  return { ...fields, slug: serverConflict ? fields.slug : slugMessage(slug) };
}

/**
 * New project: a starter, a name, an optional description and, behind a
 * disclosure, the URL. "Create project" is always enabled and validation
 * runs on submit, so an empty form explains itself instead of going dead.
 *
 * Blank closes the dialog and leaves the new card in the list. A template
 * writes its files through the ordinary files API, saves the run command,
 * then opens the workspace on the entry file. The project exists from the
 * first POST on, so a failed write offers a retry or opening it as it is.
 */
export function CreateProjectDialog({
  open,
  onOpenChange,
  starter = 'blank',
  onCreated,
}: CreateProjectDialogProps): ReactElement {
  const navigate = useNavigate();
  const [starterId, setStarterId] = useState<StarterId>(starter);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [slug, setSlug] = useState('');
  const [customSlug, setCustomSlug] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | undefined>();
  const [phase, setPhase] = useState<Phase>({ kind: 'form' });
  const create = useAction(createProject);
  const { reset: resetCreate } = create;
  const nameRef = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Every opening starts clean, on the starter the opener asked for.
  useEffect(() => {
    if (!open) return;
    setStarterId(starter);
    setName('');
    setDescription('');
    setSlug('');
    setCustomSlug(false);
    setErrors({});
    setFormError(undefined);
    setPhase({ kind: 'form' });
    resetCreate();
  }, [open, starter, resetCreate]);

  const template = findStarter(starterId) ?? findStarter('blank')!;
  // The same function the server uses, so the preview is a promise it keeps.
  const derived = slugify(name);
  const effectiveSlug = customSlug ? slug.trim() : derived;
  const busy = create.busy || phase.kind === 'writing';

  const writeStarter = async (
    project: ProjectSummary,
    chosen: StarterTemplate,
    from: number,
  ): Promise<void> => {
    const files = chosen.files(project.name);
    // Files first, then the run command: one extra step after the last file.
    const total = files.length + (chosen.runCommand ? 1 : 0);
    for (let step = from; step < total; step++) {
      if (!mounted.current) return;
      setPhase({ kind: 'writing', project, template: chosen, step, total });
      const file = files[step];
      try {
        if (file) {
          await writeFile(project.id, { path: file.path, content: file.content, encoding: 'utf8' });
        } else if (chosen.runCommand) {
          await setRunCommand(project.id, chosen.runCommand);
        }
      } catch (error) {
        if (!mounted.current) return;
        const what = file ? `Could not add ${file.path}.` : 'Could not save the run command.';
        const detail = error instanceof Error ? error.message : undefined;
        setPhase({
          kind: 'failed',
          project,
          template: chosen,
          step,
          total,
          message: detail ? `${what} ${detail}` : what,
        });
        return;
      }
    }
    if (!mounted.current) return;
    onOpenChange(false);
    void navigate(`/projects/${project.id}`, {
      state: chosen.entryFile ? { openFile: chosen.entryFile } : undefined,
    });
  };

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (busy) return;
    setFormError(undefined);

    const trimmedDescription = description.trim();
    const candidate = {
      name,
      ...(trimmedDescription ? { description: trimmedDescription } : {}),
      ...(customSlug && slug.trim() ? { slug: slug.trim() } : {}),
    };

    const parsed = createProjectRequestSchema.safeParse(candidate);
    if (!parsed.success) {
      const fields: FieldErrors = {};
      for (const issue of parsed.error.issues) {
        const path = issue.path.map(String).join('.');
        if (path && !(path in fields)) fields[path] = issue.message;
      }
      setErrors(mapFieldErrors(fields, slug.trim()));
      return;
    }

    const outcome = await create.run(parsed.data);
    if (!outcome.ok) {
      const mapped = fieldErrorsFrom(outcome.error);
      if (mapped.fields.slug && !customSlug) {
        // The URL was derived for them; show the field so they can change it.
        setCustomSlug(true);
        setSlug(derived);
      }
      setErrors(mapFieldErrors(mapped.fields, effectiveSlug));
      if (mapped.message) setFormError(mapped.message);
      return;
    }

    const project = outcome.value;
    onCreated(project);
    if (template.id === 'blank') {
      // The new card appearing at the top of the list is the confirmation; a
      // toast naming the project would be a second element with its name.
      onOpenChange(false);
      return;
    }
    await writeStarter(project, template, 0);
  };

  const close = (): void => {
    if (phase.kind === 'writing') return;
    onOpenChange(false);
  };

  const slugHint = customSlug
    ? effectiveSlug && projectSlugSchema.safeParse(effectiveSlug).success
      ? `Opens at /${effectiveSlug}`
      : 'Lowercase letters, numbers and hyphens.'
    : undefined;

  const footer =
    phase.kind === 'form' ? (
      <>
        <Button size="lg" onClick={close} disabled={busy}>
          Cancel
        </Button>
        <Button
          type="submit"
          form="create-project-form"
          variant="primary"
          size="lg"
          loading={busy}
          loadingLabel="Creating the project"
        >
          Create project
        </Button>
      </>
    ) : phase.kind === 'writing' ? (
      <Button size="lg" disabledReason="Files are being added">
        Cancel
      </Button>
    ) : (
      <>
        <Button
          size="lg"
          onClick={() => {
            onOpenChange(false);
            void navigate(`/projects/${phase.project.id}`);
          }}
        >
          Open anyway
        </Button>
        <Button
          variant="primary"
          size="lg"
          onClick={() => void writeStarter(phase.project, phase.template, phase.step)}
        >
          Retry adding files
        </Button>
      </>
    );

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
        else onOpenChange(true);
      }}
      title="New project"
      size="md"
      footer={footer}
      initialFocus={nameRef}
      className="create-project"
    >
      {phase.kind === 'form' ? (
        <form
          id="create-project-form"
          className="create-project__form"
          onSubmit={submit}
          noValidate
        >
          <div className="create-project__group">
            <span className="create-project__legend" id="create-project-starter">
              Start from
            </span>
            <StarterPicker
              label="Start from"
              value={starterId}
              onChange={setStarterId}
              disabled={busy}
            />
          </div>

          <Field
            id="create-project-name"
            label="Project name"
            error={errors.name}
            {...(!customSlug && derived ? { hint: `Opens at /${derived}` } : {})}
          >
            <Input
              ref={nameRef}
              id="create-project-name"
              name="name"
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                setErrors((current) => ({ ...current, name: undefined }));
              }}
              invalid={Boolean(errors.name)}
              aria-describedby={
                errors.name
                  ? 'create-project-name-error'
                  : !customSlug && derived
                    ? 'create-project-name-hint'
                    : undefined
              }
              disabled={busy}
              autoComplete="off"
            />
          </Field>

          <Field
            id="create-project-description"
            label="Description (optional)"
            as="textarea"
            rows={2}
            value={description}
            onChange={(event) => {
              setDescription(event.target.value);
              setErrors((current) => ({ ...current, description: undefined }));
            }}
            error={errors.description}
            disabled={busy}
          />

          {customSlug ? (
            <Field
              id="create-project-slug"
              label="Project URL"
              error={errors.slug}
              {...(slugHint ? { hint: slugHint } : {})}
            >
              <Input
                id="create-project-slug"
                name="slug"
                mono
                value={slug}
                spellCheck={false}
                autoCapitalize="off"
                autoComplete="off"
                onChange={(event) => {
                  setSlug(event.target.value);
                  setErrors((current) => ({ ...current, slug: undefined }));
                }}
                onBlur={() => {
                  // Reserved and malformed URLs are caught here, before a round trip.
                  const value = slug.trim();
                  if (value && !projectSlugSchema.safeParse(value).success) {
                    setErrors((current) => ({ ...current, slug: slugMessage(value) }));
                  }
                }}
                invalid={Boolean(errors.slug)}
                aria-describedby={
                  errors.slug
                    ? 'create-project-slug-error'
                    : slugHint
                      ? 'create-project-slug-hint'
                      : undefined
                }
                disabled={busy}
              />
            </Field>
          ) : (
            <div>
              <Button
                variant="link"
                onClick={() => {
                  setCustomSlug(true);
                  setSlug(derived);
                }}
                disabled={busy}
              >
                Choose the URL yourself
              </Button>
            </div>
          )}

          {formError ? <Callout tone="danger" title={formError} /> : null}
        </form>
      ) : (
        <div className="create-project__progress">
          <p className="create-project__progress-title">
            {phase.project.name} is ready. Adding the {phase.template.name} starter.
          </p>
          <Progress
            value={phase.kind === 'failed' ? phase.step : phase.step + 1}
            max={phase.total}
            label="Adding starter files"
          />
          <p className="create-project__progress-step" aria-live="polite">
            {phase.kind === 'writing'
              ? phase.step < phase.template.files(phase.project.name).length
                ? `Adding ${phase.step + 1} of ${phase.template.files(phase.project.name).length} files…`
                : 'Saving the run command…'
              : null}
          </p>
          {phase.kind === 'failed' ? <Callout tone="danger" title={phase.message} /> : null}
        </div>
      )}
    </Dialog>
  );
}
