import { vi } from 'vitest';

export const publicUser = {
  id: '018f0000-0000-7000-8000-000000000001',
  email: 'ada@example.test',
  username: 'ada',
  displayName: null,
  emailVerified: false,
  isOperator: false,
  createdAt: '2026-01-01T00:00:00.000Z',
};

export const PROJECT_ID = '018f0000-0000-7000-8000-0000000000aa';

export const project = (overrides: Record<string, unknown> = {}) => ({
  id: PROJECT_ID,
  slug: 'hello-world',
  name: 'Hello World',
  description: null,
  role: 'OWNER',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

export const noRuntime = {
  runtime: null,
  detected: null,
  provider: { name: 'none', available: false, reason: 'No execution backend is configured.' },
};

export const noDeployments = {
  deployments: [],
  subdomain: null,
  url: null,
  config: null,
  suggestion: null,
  liveId: null,
  unavailableReason: 'Deployments are not available on this installation.',
  limit: 10,
};

export const members = (role = 'OWNER') => ({
  members: [
    {
      userId: publicUser.id,
      username: 'ada',
      displayName: null,
      role,
      joinedAt: '2026-01-01T00:00:00.000Z',
    },
    {
      userId: '018f0000-0000-7000-8000-000000000002',
      username: 'grace',
      displayName: 'Grace Hopper',
      role: role === 'OWNER' ? 'EDITOR' : 'OWNER',
      joinedAt: '2026-01-02T00:00:00.000Z',
    },
  ],
  viewerPermissions: role === 'OWNER' ? ['member:read', 'member:manage'] : ['member:read'],
});

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export type Handlers = Record<string, (init?: RequestInit) => Response>;

export function routeFetch(handlers: Handlers) {
  const calls: string[] = [];
  const spy = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${String(input)}`;
    calls.push(key);
    const match = Object.keys(handlers).find((k) => key.includes(k));
    if (!match) return Promise.resolve(json({ error: { code: 'NOT_FOUND' } }, 404));
    return Promise.resolve(handlers[match]!(init));
  });
  vi.stubGlobal('fetch', spy);
  return calls;
}

export const baseHandlers = (role = 'OWNER'): Handlers => ({
  'GET /api/auth/me': () => json({ user: publicUser }),
  [`GET /api/projects/${PROJECT_ID}/runtime`]: () => json(noRuntime),
  [`GET /api/projects/${PROJECT_ID}/deployments`]: () => json(noDeployments),
  [`GET /api/projects/${PROJECT_ID}/members`]: () => json(members(role)),
  [`GET /api/projects/${PROJECT_ID}`]: () => json({ project: project({ role }) }),
});
