import { Component, type ErrorInfo, type ReactElement, type ReactNode } from 'react';
import { copyText } from '../lib/clipboard.js';
import { Button, EmptyState, toast } from '../ui/index.js';
import { Warning } from '../ui/icons.js';

interface Props {
  children: ReactNode;
  /** When this changes the boundary forgets the error, so navigating away recovers. */
  resetKey?: string;
}

interface State {
  error: Error | undefined;
}

/**
 * Catches a render crash below it and shows a page-size fallback with the way
 * out, instead of a blank screen and a console error. Wraps the routes; the
 * workspace adds its own per-panel boundaries so a crash in one panel does not
 * take the editor and its unsaved buffers with it.
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: undefined };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // The default would be swallowed with the render; keep it for the console.
    console.error(error, info.componentStack);
  }

  override componentDidUpdate(previous: Props): void {
    if (this.state.error && previous.resetKey !== this.props.resetKey) {
      this.setState({ error: undefined });
    }
  }

  override render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return <ErrorFallback error={this.state.error} />;
  }
}

function describe(error: Error): string {
  return [`${error.name}: ${error.message}`, `at ${window.location.href}`, error.stack ?? ''].join(
    '\n',
  );
}

export function ErrorFallback({ error }: { error: Error }): ReactElement {
  const copy = async (): Promise<void> => {
    const copied = await copyText(describe(error));
    toast(
      copied
        ? { tone: 'success', title: 'Details copied' }
        : { tone: 'danger', title: 'Could not copy the details' },
    );
  };
  return (
    <EmptyState
      size="page"
      icon={Warning}
      title={
        <span role="heading" aria-level={1}>
          Something went wrong on this page
        </span>
      }
      body="Reload the page. If it keeps happening, copy the details and report them."
      action={
        <Button variant="primary" size="lg" onClick={() => window.location.reload()}>
          Reload
        </Button>
      }
      secondary={
        <>
          <Button size="lg" onClick={() => void copy()}>
            Copy details
          </Button>
          <Button variant="ghost" size="lg" asChild>
            {/* A full load, so the crashed tree is gone even when already at "/". */}
            <a href="/">Go to projects</a>
          </Button>
        </>
      }
    />
  );
}
