import type { ReactElement } from 'react';
import { useAuth } from '../lib/auth-context.js';
import { Landing } from './projects/Landing.js';
import { ProjectsPage } from './ProjectsPage.js';

export function HomePage(): ReactElement {
  const { status, reachable, refresh } = useAuth();

  if (status === 'authenticated') return <ProjectsPage />;
  if (status === 'unknown') return <Landing loading />;

  return <Landing unreachable={!reachable} onRetry={() => void refresh()} />;
}
