import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ProjectSummary, PublicUser } from '@platform/shared';
import { fetchRunState } from '../lib/runtime-api.js';
import { fetchRuntimeEvents } from '../lib/runtime-events-api.js';
import { useResource } from '../lib/use-resource.js';
import { readStorage, writeStorage } from './storage.js';

export const CHECKLIST_PROJECT_LIMIT = 3;

export type ChecklistItemId = 'create' | 'start' | 'run' | 'preview' | 'email';

export interface ChecklistItem {
  id: ChecklistItemId;
  label: string;
  detail: string;
  done: boolean;
}

export const CHECKLIST_LENGTH = 5;

function hiddenKey(userId: string): string {
  return `onboarding.hidden.v1.${userId}`;
}

function previewKey(userId: string): string {
  return `onboarding.preview.v1.${userId}`;
}

export function markPreviewOpened(userId: string): void {
  writeStorage(previewKey(userId), new Date().toISOString());
}

export function hasOpenedPreview(userId: string): boolean {
  return readStorage(previewKey(userId)) !== null;
}

export function newestProject(projects: readonly ProjectSummary[]): ProjectSummary | undefined {
  return [...projects].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
}

export interface Onboarding {
  visible: boolean;
  status: 'loading' | 'ready' | 'error';
  items: ChecklistItem[];
  doneCount: number;
  project: ProjectSummary | undefined;
  hide: () => void;
  reload: () => void;
}

export function useOnboarding(user: PublicUser, projects: readonly ProjectSummary[]): Onboarding {
  const [hidden, setHidden] = useState(() => readStorage(hiddenKey(user.id)) !== null);
  const [previewOpened, setPreviewOpened] = useState(() => hasOpenedPreview(user.id));
  const project = useMemo(() => newestProject(projects), [projects]);
  const projectId = project?.id;
  const eligible = !hidden && projects.length < CHECKLIST_PROJECT_LIMIT;
  const readFor = eligible ? projectId : undefined;

  const events = useResource(
    (signal) => (readFor ? fetchRuntimeEvents(readFor, signal) : Promise.resolve([])),
    [readFor],
  );
  const run = useResource(
    (signal) => (readFor ? fetchRunState(readFor, signal) : Promise.resolve(null)),
    [readFor],
  );

  useEffect(() => {
    const onStorage = (event: StorageEvent): void => {
      if (event.key === previewKey(user.id)) setPreviewOpened(event.newValue !== null);
    };
    const onFocus = (): void => setPreviewOpened(hasOpenedPreview(user.id));
    window.addEventListener('storage', onStorage);
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('focus', onFocus);
    };
  }, [user.id]);

  const items = useMemo<ChecklistItem[]>(() => {
    const runState = run.data ?? null;
    return [
      {
        id: 'create',
        label: 'Create a project',
        detail: 'Your code, an environment to run it in, and a preview to share.',
        done: projects.length > 0,
      },
      {
        id: 'start',
        label: 'Start its environment',
        detail: 'Press Start in the workspace toolbar. The first start pulls the image.',
        done: (events.data?.length ?? 0) > 0,
      },
      {
        id: 'run',
        label: 'Run the app',
        detail: 'Press Run in the console. Output appears there as it is printed.',
        done: runState !== null && (runState.status !== 'IDLE' || runState.startedAt !== null),
      },
      {
        id: 'preview',
        label: 'Open the preview',
        detail: 'When the app listens on a port, the preview shows it.',
        done: previewOpened,
      },
      {
        id: 'email',
        label: 'Confirm your email',
        detail: 'So password resets and alerts can reach you.',
        done: user.emailVerified,
      },
    ];
  }, [projects.length, events.data, run.data, previewOpened, user.emailVerified]);

  const doneCount = items.filter((item) => item.done).length;
  const allDone = doneCount === items.length;

  const hide = useCallback(() => {
    writeStorage(hiddenKey(user.id), new Date().toISOString());
    setHidden(true);
  }, [user.id]);

  const reloadEvents = events.reload;
  const reloadRun = run.reload;
  const reload = useCallback(() => {
    reloadEvents();
    reloadRun();
  }, [reloadEvents, reloadRun]);

  const failed = events.status === 'error' || run.status === 'error';
  const loading =
    readFor !== undefined &&
    ((events.status === 'loading' && events.data === undefined) ||
      (run.status === 'loading' && run.data === undefined));

  return {
    visible: eligible && !allDone,
    status: failed ? 'error' : loading ? 'loading' : 'ready',
    items,
    doneCount,
    project,
    hide,
    reload,
  };
}
