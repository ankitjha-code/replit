import { useEffect, useState } from 'react';

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
