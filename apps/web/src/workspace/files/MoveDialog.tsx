import { useState, type ReactElement } from 'react';
import type { FileEntry } from '@platform/shared';
import { Button, Callout, Dialog } from '../../ui/index.js';
import { FolderSimple } from '../../ui/icons.js';
import { moveTargets } from './file-actions.js';

/**
 * "Move to…": the folder picker behind the menu item (design spec 9.4).
 *
 * A list of the project's folders rather than a typed path, so a move can
 * only go somewhere real. Renaming to "folder/name" still moves too, for
 * anyone who prefers to type.
 */
export function MoveDialog({
  path,
  entries,
  onMove,
  onClose,
}: {
  /** The entry being moved; undefined closes the dialog. */
  path: string | undefined;
  entries: readonly FileEntry[];
  /** Resolves when moved; rejects with the reason to show. */
  onMove: (from: string, directory: string) => Promise<void>;
  onClose: () => void;
}): ReactElement {
  const [pending, setPending] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const name = path?.split('/').pop() ?? '';
  const targets = path ? moveTargets(path, entries) : [];

  const choose = (directory: string): void => {
    if (!path || pending !== undefined) return;
    setPending(directory);
    setError(undefined);
    onMove(path, directory).then(
      () => {
        setPending(undefined);
        onClose();
      },
      (cause: unknown) => {
        setPending(undefined);
        setError(cause instanceof Error ? cause.message : 'That did not work. Please try again.');
      },
    );
  };

  return (
    <Dialog
      open={path !== undefined}
      onOpenChange={(open) => {
        if (!open && pending === undefined) {
          setError(undefined);
          onClose();
        }
      }}
      title={`Move ${name}`}
      description="Choose the folder it should go into."
      size="sm"
      footer={
        <Button variant="ghost" onClick={onClose} disabled={pending !== undefined}>
          Cancel
        </Button>
      }
    >
      {error ? (
        <Callout tone="danger" title={error} className="files-move__error">
          Choose a folder to try again.
        </Callout>
      ) : null}
      {targets.length === 0 ? (
        <p className="files-move__empty">
          There is no other folder to move it to. Create a folder first, then move it there.
        </p>
      ) : (
        <ul className="files-move__list" aria-label="Folders">
          {targets.map((directory) => (
            <li key={directory || '(root)'}>
              <Button
                variant="ghost"
                className="files-move__target"
                icon={FolderSimple}
                loading={pending === directory}
                disabled={pending !== undefined && pending !== directory}
                onClick={() => choose(directory)}
              >
                {directory === '' ? 'Project root' : `${directory}/`}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}
