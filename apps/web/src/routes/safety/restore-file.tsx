import { useState } from 'react';
import type { RestoreFileResponse } from '@platform/shared';
import { ApiError } from '../../lib/api-client.js';
import { fetchFileTree, writeFile } from '../../lib/files-api.js';
import { useAction } from '../../lib/use-action.js';
import { Button, Callout } from '../../ui/index.js';

/**
 * One file put back from a commit or a snapshot, with what is needed to undo it.
 *
 * A one-file restore takes no safety snapshot (one file does not justify
 * copying the whole project), so the undo lives on the page: the previous
 * content comes back in the answer, and the file's version right after the
 * restore is remembered so the undo refuses to overwrite a newer edit.
 */
export interface RestoredFile {
  path: string;
  /** What the file held before, or null when it did not exist. */
  previous: RestoreFileResponse['previous'];
  /** The file's version right after the restore; undefined when it could not be read. */
  version: number | undefined;
  /** Where it came from: "commit abc1234", "snapshot Before the rewrite". */
  source: string;
}

export async function restoreOneFile(
  projectId: string,
  source: string,
  run: () => Promise<RestoreFileResponse>,
): Promise<RestoredFile> {
  const result = await run();
  let version: number | undefined;
  try {
    const tree = await fetchFileTree(projectId);
    version = tree.entries.find((entry) => entry.path === result.path)?.version;
  } catch {
    // The restore itself succeeded; without a version the undo simply does not check.
  }
  return { path: result.path, previous: result.previous, version, source };
}

type UndoOutcome = 'undone' | 'moved';

/** Said after a one-file restore, with the way back. */
export function RestoredFileCallout({
  projectId,
  restored,
  onDismiss,
}: {
  projectId: string;
  restored: RestoredFile;
  onDismiss: () => void;
}): React.JSX.Element {
  const [outcome, setOutcome] = useState<UndoOutcome | undefined>();
  const undo = useAction(async () => {
    if (!restored.previous) return;
    try {
      await writeFile(projectId, {
        path: restored.path,
        content: restored.previous.content,
        encoding: restored.previous.encoding,
        ...(restored.version !== undefined ? { expectedVersion: restored.version } : {}),
      });
      setOutcome('undone');
    } catch (cause) {
      // Somebody edited the file after the restore: leaving it alone is the safe answer.
      if (cause instanceof ApiError && cause.code === 'CONFLICT') {
        setOutcome('moved');
        return;
      }
      throw cause;
    }
  });

  if (outcome === 'undone') {
    return (
      <Callout
        tone="ok"
        title={`${restored.path} is back to what it was before the restore.`}
        onDismiss={onDismiss}
      />
    );
  }
  if (outcome === 'moved') {
    return (
      <Callout
        tone="warn"
        title={`${restored.path} has changed since the restore, so it was left alone.`}
        onDismiss={onDismiss}
      />
    );
  }

  return (
    <Callout
      tone="ok"
      title={`Restored ${restored.path} from ${restored.source}.`}
      onDismiss={onDismiss}
      action={
        restored.previous ? (
          <Button
            size="sm"
            loading={undo.busy}
            loadingLabel="Undoing the restore"
            onClick={() => void undo.run()}
          >
            Undo
          </Button>
        ) : undefined
      }
    >
      {restored.previous
        ? 'Undo puts back what the file held a moment ago, as long as nobody has edited it since.'
        : 'The file did not exist before, so there is nothing to undo.'}
      {undo.error ? (
        <p role="alert" className="safety-muted">
          The change could not be undone: {undo.error.message}
        </p>
      ) : null}
    </Callout>
  );
}
