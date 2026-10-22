import { Suspense, lazy } from 'react';
import { Button } from '../../ui/Button/Button.js';
import { Dialog } from '../../ui/Dialog/Dialog.js';
import { Skeleton } from '../../ui/Skeleton/Skeleton.js';

const CompareEditor = lazy(() => import('./CompareEditor.js'));

export interface CompareDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  fileName: string;
  language: string;
  theirs: string;
  mine: string;
  onKeepMine: () => void;
  onUseTheirs: () => void;
}

export function CompareDialog({
  open,
  onOpenChange,
  fileName,
  language,
  theirs,
  mine,
  onKeepMine,
  onUseTheirs,
}: CompareDialogProps): React.JSX.Element {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Compare versions of ${fileName}`}
      description="The server's version is on the left and your text is on the right. Choose which one to keep."
      size="lg"
      className="editor-compare"
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="secondary" onClick={onUseTheirs}>
            Use theirs
          </Button>
          <Button variant="primary" onClick={onKeepMine}>
            Keep mine
          </Button>
        </>
      }
    >
      <div className="editor-compare__labels" aria-hidden="true">
        <span>Theirs</span>
        <span>Mine</span>
      </div>
      <Suspense
        fallback={
          <div
            className="editor-compare__loading"
            role="status"
            aria-label="Loading the comparison"
          >
            <Skeleton shape="block" />
          </div>
        }
      >
        <CompareEditor theirs={theirs} mine={mine} language={language} />
      </Suspense>
    </Dialog>
  );
}
