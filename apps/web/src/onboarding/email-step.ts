import { useLayoutEffect, useSyncExternalStore } from 'react';

let showing = 0;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const snapshot = (): boolean => showing > 0;

export function useShowsEmailStep(active: boolean): void {
  useLayoutEffect(() => {
    if (!active) return;
    showing += 1;
    notify();
    return () => {
      showing -= 1;
      notify();
    };
  }, [active]);
}

export function useEmailStepOnChecklist(): boolean {
  return useSyncExternalStore(subscribe, snapshot, () => false);
}
