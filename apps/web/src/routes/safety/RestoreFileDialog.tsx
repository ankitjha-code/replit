import { useEffect, useId, useState, type FormEvent } from 'react';
import type { FileTreeResponse, RestoreFileResponse } from '@platform/shared';
import { Field } from '../../components/Field.js';
import { fetchFileTree } from '../../lib/files-api.js';
import { useAction } from '../../lib/use-action.js';
import { useResource } from '../../lib/use-resource.js';
import { Button, Callout, Dialog, Input } from '../../ui/index.js';
import { restoreOneFile, type RestoredFile } from './restore-file.js';

const NO_TREE: FileTreeResponse = { entries: [], totalBytes: 0 };

export function RestoreFileDialog({
  projectId,
  open,
  onOpenChange,
  source,
  restore,
  onRestored,
}: {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  source: string;
  restore: (path: string) => Promise<RestoreFileResponse>;
  onRestored: (restored: RestoredFile) => void;
}): React.JSX.Element {
  const listId = useId();
  const [path, setPath] = useState('');
  const [pathError, setPathError] = useState<string | undefined>();
  const tree = useResource(
    (signal) => (open ? fetchFileTree(projectId, signal) : Promise.resolve(NO_TREE)),
    [projectId, open],
  );
  const run = useAction((wanted: string) =>
    restoreOneFile(projectId, source, () => restore(wanted)),
  );

  useEffect(() => {
    if (open) {
      setPath('');
      setPathError(undefined);
      run.reset();
    }
  }, [open]);

  const files = (tree.data?.entries ?? []).filter((entry) => entry.type === 'FILE');
  const trimmed = path.trim();
  const known = files.some((entry) => entry.path === trimmed);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (trimmed === '') {
      setPathError('Enter the path of the file to restore');
      return;
    }
    setPathError(undefined);
    const outcome = await run.run(trimmed);
    if (outcome.ok) {
      onRestored(outcome.value);
      onOpenChange(false);
    }
  };

  const formId = `${listId}-form`;

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Restore one file from ${source}`}
      description="The file becomes what it was then. The project keeps running, and the change can be undone."
      loading={tree.status === 'loading'}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="submit"
            form={formId}
            variant="primary"
            loading={run.busy}
            loadingLabel="Restoring the file"
          >
            Restore file
          </Button>
        </>
      }
    >
      <form id={formId} className="safety-dialog-form" onSubmit={(event) => void submit(event)}>
        {tree.status === 'error' ? (
          <Callout
            tone="warn"
            title="The project files could not be listed."
            action={
              <Button size="sm" onClick={tree.reload}>
                Retry
              </Button>
            }
          >
            You can still type the path.
          </Callout>
        ) : null}
        <Field
          id={`${listId}-path`}
          label="File"
          error={pathError}
          hint={
            trimmed !== '' && !known
              ? 'This file is not in the project now. It is created if the archive holds it.'
              : 'Start typing to pick from the files the project has now.'
          }
        >
          <Input
            id={`${listId}-path`}
            name="path"
            mono
            list={listId}
            autoComplete="off"
            placeholder="src/index.js"
            value={path}
            invalid={Boolean(pathError)}
            aria-describedby={pathError ? `${listId}-path-error` : `${listId}-path-hint`}
            onChange={(event) => {
              setPath(event.target.value);
              if (pathError) setPathError(undefined);
              if (run.error) run.reset();
            }}
          />
        </Field>
        <datalist id={listId}>
          {files.map((entry) => (
            <option key={entry.path} value={entry.path} />
          ))}
        </datalist>
        {run.error ? <Callout tone="danger" title={run.error.message} /> : null}
      </form>
    </Dialog>
  );
}
