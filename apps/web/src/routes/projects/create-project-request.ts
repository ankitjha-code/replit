import { useEffect } from 'react';
import type { StarterId } from '../../lib/starter-templates.js';

export const CREATE_PROJECT_EVENT = 'projects:create';

let pending: StarterId | undefined;

export function openCreateProject(starter: StarterId = 'blank'): void {
  pending = starter;
  window.dispatchEvent(new CustomEvent<StarterId>(CREATE_PROJECT_EVENT, { detail: starter }));
}

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
