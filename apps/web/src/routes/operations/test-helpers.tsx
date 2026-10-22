import { render } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { RequireAuth } from '../../components/RequireAuth.js';
import { AuthProvider } from '../../lib/auth-context.js';
import { UiProvider } from '../../ui/index.js';
import { OperationsPage } from '../OperationsPage.js';
import { json, publicUser, routeFetch, type Handlers } from '../settings/test-helpers.js';

export { json, routeFetch };

export const operator = { ...publicUser, isOperator: true };

/** A second account, never the one signed in, so the own-row rule can be seen. */
export const OTHER_ID = '018f0000-0000-7000-8000-000000000002';

/** Renders the operations pages the way the shell does: behind RequireAuth, with the shell's neighbours. */
export function renderOperations(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <UiProvider>
          <Routes>
            <Route path="/" element={<h1>Your projects</h1>} />
            <Route path="/status" element={<h1>System status</h1>} />
            <Route
              path="/operations/*"
              element={
                <RequireAuth>
                  <OperationsPage />
                </RequireAuth>
              }
            />
          </Routes>
        </UiProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
}

export const overview = () => ({
  accounts: { total: 12, verified: 9, operators: 2 },
  projects: { total: 30, running: 4 },
  deployments: { live: 5, failed: 1 },
  jobs: { queued: 3, running: 1, failed: 2 },
});

export const host = (name: string, draining = false, reason: string | null = null) => ({
  name,
  schedulable: !draining && reason === null,
  draining,
  reason,
  cpuMillicores: { used: 1500, declared: 4000 },
  memoryMb: { used: 2048, declared: 4096 },
  workloads: { used: 2, declared: 10 },
});

export const account = (overrides: Record<string, unknown> = {}) => ({
  id: OTHER_ID,
  username: 'grace',
  email: 'grace@example.test',
  emailVerified: true,
  isOperator: false,
  projects: 3,
  createdAt: '2026-01-02T00:00:00.000Z',
  ...overrides,
});

export const quotas = (runtimes: number | null) => ({
  quotas: [
    {
      kind: 'RUNTIMES',
      used: 1,
      limit: runtimes ?? 3,
      defaultLimit: 3,
      overridden: runtimes !== null,
    },
    { kind: 'DEPLOYMENTS', used: 0, limit: 2, defaultLimit: 2, overridden: false },
    { kind: 'BUILDS', used: 0, limit: 1, defaultLimit: 1, overridden: false },
  ],
});

const step = (found: number, orphaned: number, removed: number, failed = 0) => ({
  found,
  orphaned,
  removed,
  failed,
  skipped: null,
});

export const sweepReport = (dryRun: boolean, orphans = 2) => ({
  startedAt: '2026-01-03T10:00:00.000Z',
  finishedAt: '2026-01-03T10:00:04.000Z',
  dryRun,
  containers: step(5, orphans, dryRun ? 0 : orphans),
  networks: step(3, 0, 0),
  databases: step(0, 0, 0, 0),
  objects: { found: 0, orphaned: 0, removed: 0, failed: 0, skipped: 'No object store' },
  sessions: { removed: 4 },
  tokens: { removed: 1 },
});

/** A signed-in operator whose every other read is quiet. */
export const operationsHandlers = (): Handlers => ({
  'GET /api/auth/me': () => json({ user: operator }),
  'GET /api/operations/overview': () => json(overview()),
  'GET /api/operations/hosts': () => json({ hosts: [host('alpha')] }),
  'GET /api/operations/accounts': () => json({ accounts: [], nextCursor: null }),
  'GET /api/operations/audit': () => json({ entries: [] }),
});
