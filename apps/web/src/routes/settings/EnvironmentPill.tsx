import type { RuntimeStateResponse } from '@platform/shared';
import { Skeleton, StatusPill, type Tone } from '../../ui/index.js';

interface EnvironmentWords {
  word: string;
  tone: Tone;
  live: boolean;
}

export function describeEnvironment(state: RuntimeStateResponse | undefined): EnvironmentWords {
  const status = state?.runtime?.status;
  switch (status) {
    case 'REQUESTED':
    case 'CREATING':
    case 'STARTING':
      return { word: 'Starting', tone: 'info', live: true };
    case 'RUNNING':
      return { word: 'Running', tone: 'ok', live: true };
    case 'STOPPING':
      return { word: 'Stopping', tone: 'warn', live: true };
    case 'FAILED':
      return { word: 'Failed', tone: 'danger', live: false };
    case 'STOPPED':
      return { word: 'Stopped', tone: 'neutral', live: false };
    default:
      return state && !state.provider.available
        ? { word: 'Not available', tone: 'neutral', live: false }
        : { word: 'Stopped', tone: 'neutral', live: false };
  }
}

export function EnvironmentPill({
  state,
  loading,
}: {
  state: RuntimeStateResponse | undefined;
  loading: boolean;
}): React.JSX.Element {
  if (loading && !state) {
    return <Skeleton width={140} height={20} />;
  }
  const { word, tone, live } = describeEnvironment(state);
  return (
    <StatusPill tone={tone} dot={live} aria-live="polite">
      Environment: {word}
    </StatusPill>
  );
}
