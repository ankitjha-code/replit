import { render } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { RequireAuth } from '../../components/RequireAuth.js';
import { AuthProvider } from '../../lib/auth-context.js';
import { UiProvider } from '../../ui/index.js';
import { AccountPage } from '../AccountPage.js';
import { json, publicUser, routeFetch, type Handlers } from '../settings/test-helpers.js';

export { json, publicUser, routeFetch };

export function renderAccount(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <UiProvider>
          <Routes>
            <Route path="/login" element={<h1>Sign in</h1>} />
            <Route
              path="/account/*"
              element={
                <RequireAuth>
                  <AccountPage />
                </RequireAuth>
              }
            />
          </Routes>
        </UiProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
}

export const accountHandlers = (): Handlers => ({
  'GET /api/auth/me': () => json({ user: publicUser }),
  'GET /api/account/two-factor': () =>
    json({ enabled: false, recoveryCodesLeft: 0, available: true }),
  'GET /api/account/sessions': () => json({ sessions: [] }),
  'GET /api/auth/verification': () =>
    json({ email: publicUser.email, verified: false, canSend: true, reason: null }),
  'GET /api/quotas': () => json({ quotas: [] }),
});

export function meThenNobody(): () => Response {
  let reads = 0;
  return () => {
    reads += 1;
    return json({ user: reads === 1 ? publicUser : null });
  };
}

export const sessions = () => ({
  sessions: [
    {
      id: 'sess-current',
      current: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      lastSeenAt: '2026-01-02T00:00:00.000Z',
      expiresAt: '2026-02-01T00:00:00.000Z',
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130.0 Safari/537.36',
      ipAddress: '127.0.0.1',
    },
    {
      id: 'sess-other',
      current: false,
      createdAt: '2025-12-20T00:00:00.000Z',
      lastSeenAt: '2025-12-28T00:00:00.000Z',
      expiresAt: '2026-01-20T00:00:00.000Z',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
      ipAddress: null,
    },
  ],
});
