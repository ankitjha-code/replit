import { useEffect } from 'react';
import type { StarterId } from '../../lib/starter-templates.js';

/**
 * How anything outside the projects page opens the create dialog.
 *
 * The command palette lives in the shell and the dialog lives on `/`, so the
 * request travels as a window event. A request made before the page has
 * mounted (the palette navigates home first) is kept and consumed on mount,
 * so `navigate('/'); openCreateProject();` works from anywhere.
 */
export const CREATE_PROJECT_EVENT = 'projects:create';

let pending: StarterId | undefined;

export function openCreateProject(starter: StarterId = 'blank'): void {
  pending = starter;
  window.dispatchEvent(new CustomEvent<StarterId>(CREATE_PROJECT_EVENT, { detail: starter }));
}

/** Mounted by the projects page: answers the event, and any request made before it mounted. */
export function useCreateProjectRequest(open: (starter: StarterId) => void): void {
  useEffect(() => {
    const onRequest = (): void => {
      if (pending === undefined) return;
      const starter = pending;
      pending = undefined;
      open(starter);
    };
    onRequest();
    window.addEventListener(CREATE_PROJECT_EVENT, onRequest);
    return () => window.removeEventListener(CREATE_PROJECT_EVENT, onRequest);
  }, [open]);
}
