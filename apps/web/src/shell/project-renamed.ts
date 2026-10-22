import { useEffect, useState } from 'react';

/**
 * Tells the site header that a project's name changed.
 *
 * The header reads the project on its own to name it in the breadcrumb, and a
 * page that renames it has no other way to reach that copy. A window event
 * keeps the two apart; the header adopts the new name without a second read.
 */
export const PROJECT_RENAMED_EVENT = 'project:renamed';

export interface ProjectRenamed {
  id: string;
  name: string;
}

export function announceProjectRenamed(project: ProjectRenamed): void {
  window.dispatchEvent(
    new CustomEvent<ProjectRenamed>(PROJECT_RENAMED_EVENT, {
      detail: { id: project.id, name: project.name },
    }),
  );
}

/** The newest name announced for `projectId` while mounted, if any. */
export function useRenamedProjectName(projectId: string | undefined): string | undefined {
  const [renamed, setRenamed] = useState<ProjectRenamed | undefined>();
  useEffect(() => {
    const onRenamed = (event: Event): void => {
      const detail = (event as CustomEvent<ProjectRenamed>).detail;
      if (detail && typeof detail.id === 'string' && typeof detail.name === 'string') {
        setRenamed({ id: detail.id, name: detail.name });
      }
    };
    window.addEventListener(PROJECT_RENAMED_EVENT, onRenamed);
    return () => window.removeEventListener(PROJECT_RENAMED_EVENT, onRenamed);
  }, []);
  return renamed && renamed.id === projectId ? renamed.name : undefined;
}
