import { useLayoutEffect, useSyncExternalStore } from 'react';

/*
 * Whether the getting-started checklist is on screen with its "Confirm your
 * email" step still open. The home page would otherwise ask for the same thing
 * twice: once in the dismissible callout and once in the checklist, each with
 * its own "Resend link". The checklist keeps it; the callout steps aside while
 * the checklist shows the step, and comes back once the checklist is hidden or
 * finished. A module-level count rather than props because the two are placed
 * independently by the page.
 */

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

/** Called by the checklist: true while it shows the email step undone. */
export function useShowsEmailStep(active: boolean): void {
  // Before paint, so the callout never flashes beside the checklist.
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

/** Read by the callout: true while the checklist already asks for the email. */
export function useEmailStepOnChecklist(): boolean {
  return useSyncExternalStore(subscribe, snapshot, () => false);
}
