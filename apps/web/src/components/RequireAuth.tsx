import type { ReactElement, ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../lib/auth-context.js';
import { Skeleton } from '../ui/index.js';

export function PageSkeleton(): ReactElement {
  return (
    <div className="page-skeleton" aria-busy="true" aria-label="Loading">
      <Skeleton width={220} height={24} />
      <Skeleton lines={3} />
    </div>
  );
}

export function RequireAuth({ children }: { children: ReactNode }): ReactElement {
  const { status } = useAuth();
  const location = useLocation();

  if (status === 'unknown') return <PageSkeleton />;

  if (status === 'anonymous') {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  return <>{children}</>;
}
