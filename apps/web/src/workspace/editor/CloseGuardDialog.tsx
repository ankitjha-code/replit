import { useEffect, useRef, useState } from 'react';
import { Button } from '../../ui/Button/Button.js';
import { Callout } from '../../ui/Callout/Callout.js';
import { Dialog } from '../../ui/Dialog/Dialog.js';

/** Why the tab cannot simply close. */
export type CloseGuardReason = 'dirty' | 'conflict' | 'blocked' | 'deleted';

export interface CloseGuardDialogProps {
  open: boolean;
  fileName: string;
  reason: CloseGuardReason;
  /** Saves through the editor's own path. Rejects to keep the dialog open with the message. */
  onSaveAndClose: () => Promise<void>;
  onDiscard: () => void;
  onCancel: () => void;
}

const DESCRIPTIONS: Record<CloseGuardReason, string> = {
  dirty: 'Your changes are not on the server yet.',
  conflict:
    'This file changed elsewhere while you were editing. Choose which version to keep before closing, or discard your text.',
  blocked: 'The last save was refused. Try again, or discard your text.',
  deleted: 'This file was deleted. Save and close puts it back with your text.',
};

/**
 * Asks before a tab with work on it closes.
 *
 * Three answers and no default that loses anything: Save and close is the
 * primary, Discard is styled as the destructive act it is, and Esc is Cancel.
 * A conflict cannot be saved from here (the write would conflict again), so
 * that case offers only the other two.
 */
export function CloseGuardDialog({
  open,
  fileName,
  reason,
  onSaveAndClose,
  onDiscard,
  onCancel,
}: CloseGuardDialogProps): React.JSX.Element {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const saveRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  // Each opening starts clean.
  useEffect(() => {
    if (open) {
      setSaving(false);
      setError(undefined);
    }
  }, [open]);

  const canSave = reason !== 'conflict';

  const saveAndClose = async (): Promise<void> => {
    setSaving(true);
    setError(undefined);
    try {
      await onSaveAndClose();
    } catch (cause) {
      setSaving(false);
      setError(cause instanceof Error ? cause.message : 'This file could not be saved.');
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !saving) onCancel();
      }}
      title={`Save changes to ${fileName}?`}
      description={DESCRIPTIONS[reason]}
      size="sm"
      initialFocus={canSave ? saveRef : cancelRef}
      footer={
        <>
          <Button ref={cancelRef} variant="ghost" onClick={onCancel} disabled={saving}>
            Cancel
          </Button>
          <Button variant="danger" onClick={onDiscard} disabled={saving}>
            Discard
          </Button>
          {canSave && (
            <Button
              ref={saveRef}
              variant="primary"
              onClick={() => void saveAndClose()}
              loading={saving}
              loadingLabel="Saving"
            >
              Save and close
            </Button>
          )}
        </>
      }
    >
      {error && (
        <Callout tone="danger" title="Not saved">
          {error}
        </Callout>
      )}
    </Dialog>
  );
}
