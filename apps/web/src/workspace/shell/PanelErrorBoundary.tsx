import { Component, type ErrorInfo, type ReactElement, type ReactNode } from 'react';
import { Button, EmptyState } from '../../ui/index.js';
import { Warning } from '../../ui/icons.js';

interface Props {
  name: string;
  children: ReactNode;
}

interface State {
  error: Error | undefined;
}

export class PanelErrorBoundary extends Component<Props, State> {
  override state: State = { error: undefined };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`The ${this.props.name} panel crashed`, error, info.componentStack);
  }

  private readonly retry = (): void => this.setState({ error: undefined });

  override render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return <PanelErrorFallback name={this.props.name} onRetry={this.retry} />;
  }
}

export function PanelErrorFallback({
  name,
  onRetry,
}: {
  name: string;
  onRetry: () => void;
}): ReactElement {
  return (
    <EmptyState
      icon={Warning}
      size="panel"
      title={`The ${name} panel ran into a problem`}
      body="The rest of the workspace is unaffected. Try opening it again."
      action={
        <Button variant="primary" onClick={onRetry}>
          Try again
        </Button>
      }
    />
  );
}
