import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config/env.js';
import { createTestClient, resetDatabase, testDatabaseUrl } from './setup/database.js';
import { FakePasswordHasher, silentLogger, testApp, testAuth } from './setup/app.js';
import type { PrismaClient } from '../src/generated/prisma/index.js';

/**
 * Every route in the API, found by reading the route files, called by somebody
 * who should get nothing.
 *
 *  - Signed out: every route except the few that are public by design must
 *    answer 401.
 *  - Signed in, but not a member of the project in the path: every project
 *    route must answer 404 — not 403, which would confirm the project exists,
 *    and never a success.
 *
 * Routes are discovered, not listed, so a route added later without a guard
 * fails here without anybody having to remember to add it.
 */

const url = testDatabaseUrl();
const db: PrismaClient | undefined = url ? createTestClient(url) : undefined;

const MODULES = join(import.meta.dirname, '../src/modules');
const PLACEHOLDER_ID = '018f0000-0000-7000-8000-000000000000';

/** Where each route file is mounted. A new file must be added here. */
const MOUNTS: Record<string, string> = {
  'account/account.routes.ts': '/api/account',
  'auth/auth.routes.ts': '/api/auth',
  'quotas/quota.routes.ts': '/api/quotas',
  'operations/operations.routes.ts': '/api/operations',
  'projects/project.routes.ts': '/api/projects',
  'alerts/alert.routes.ts': '/api/projects/:projectId/alerts',
  'assets/asset.routes.ts': '/api/projects/:projectId/assets',
  'databases/database.routes.ts': '/api/projects/:projectId/database',
  'deployments/deployment.routes.ts': '/api/projects/:projectId/deployments',
  'domains/domain.routes.ts': '/api/projects/:projectId/domains',
  'files/file.routes.ts': '/api/projects/:projectId/files',
  'git/git.routes.ts': '/api/projects/:projectId/git',
  'jobs/job.routes.ts': '/api/projects/:projectId/jobs',
  'logs/log.routes.ts': '/api/projects/:projectId/logs',
  'monitoring/monitoring.routes.ts': '/api/projects/:projectId/monitoring',
  'preview/preview.routes.ts': '/api/projects/:projectId/preview',
  'runtimes/runtime.routes.ts': '/api/projects/:projectId/runtime',
  'secrets/secret.routes.ts': '/api/projects/:projectId/secrets',
  'snapshots/snapshot.routes.ts': '/api/projects/:projectId/snapshots',
  'variables/variable.routes.ts': '/api/projects/:projectId/variables',
  // Not under /api: liveness for load balancers, public by design.
  'health/health.routes.ts': '/health',
};

/**
 * Public by design, and why. Everything else must refuse a signed-out caller.
 */
const PUBLIC = new Set([
  'GET /health/live', // load balancers
  'GET /health/ready',
  'POST /api/auth/register',
  'POST /api/auth/login',
  'POST /api/auth/login/two-factor', // second step of signing in
  'POST /api/auth/logout', // signing out while signed out is not an error
  'GET /api/auth/me', // "nobody" is a valid answer
  // Email flows: the whole point is that the person is not signed in.
  'POST /api/auth/verification/confirm',
  'POST /api/auth/password-reset',
  'POST /api/auth/password-reset/complete',
]);

interface Route {
  method: string;
  path: string;
}

function discover(): { routes: Route[]; unmapped: string[] } {
  const routes: Route[] = [];
  const unmapped: string[] = [];
  for (const module of readdirSync(MODULES)) {
    for (const file of readdirSync(join(MODULES, module))) {
      if (!file.endsWith('.routes.ts')) continue;
      const key = `${module}/${file}`;
      const mount = MOUNTS[key];
      if (mount === undefined) {
        unmapped.push(key);
        continue;
      }
      let source = readFileSync(join(MODULES, module, file), 'utf8');
      // The certificate question lives in the domain file but is mounted at
      // /internal/tls-authorize, outside /api, and is public by design.
      if (key === 'domains/domain.routes.ts') {
        source = source.slice(0, source.indexOf('export function certificateAuthorizationRoutes'));
      }
      for (const match of source.matchAll(
        /router\.(get|post|put|patch|delete)\(\s*['`]([^'`]+)['`]/g,
      )) {
        routes.push({
          method: match[1]!.toUpperCase(),
          path: `${mount}${match[2] === '/' ? '' : match[2]}` || '/',
        });
      }
    }
  }
  return { routes, unmapped };
}

const { routes, unmapped } = discover();

function concrete(path: string, projectId: string): string {
  return path.replace(':projectId', projectId).replace(/:[A-Za-z]+/g, PLACEHOLDER_ID);
}

function send(app: ReturnType<typeof testApp>, route: Route, path: string, cookie?: string) {
  const method = route.method.toLowerCase() as 'get' | 'post' | 'put' | 'patch' | 'delete';
  const pending = request(app)[method](path).set('Origin', 'http://localhost:5173');
  if (cookie) pending.set('Cookie', cookie);
  return method === 'get' ? pending : pending.send({});
}

describe.skipIf(!db)('every route, called by somebody who should get nothing', () => {
  let app: ReturnType<typeof testApp>;
  let victimProject = '';
  let outsider = '';

  beforeAll(async () => {
    await resetDatabase(db!);
    const hasher = new FakePasswordHasher();
    const config = loadEnv({
      RATE_LIMIT_REGISTER_MAX: '100',
      RATE_LIMIT_GLOBAL_MAX: '100000',
      RATE_LIMIT_ACCOUNT_MAX: '100000',
    } as NodeJS.ProcessEnv);
    app = testApp({
      config,
      passwordHasher: hasher,
      auth: testAuth(db!, config, hasher, silentLogger()),
    });

    const register = async (name: string) => {
      const res = await request(app)
        .post('/api/auth/register')
        .send({ email: `${name}@example.test`, username: name, password: 'analytical-engine-1843' })
        .expect(201);
      return (res.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;
    };
    const owner = await register('ada');
    outsider = await register('mallory');
    const created = await request(app)
      .post('/api/projects')
      .set('Cookie', owner)
      .send({ name: 'Private' })
      .expect(201);
    victimProject = created.body.project.id as string;
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  it('knows where every route file is mounted', () => {
    expect(unmapped).toEqual([]);
    // Sanity: the parser really found the API.
    expect(routes.length).toBeGreaterThan(100);
  });

  it('refuses every non-public route to a signed-out caller', async () => {
    const leaks: string[] = [];
    for (const route of routes) {
      const name = `${route.method} ${route.path}`;
      if (PUBLIC.has(name)) continue;
      const res = await send(app, route, concrete(route.path, victimProject));
      if (res.status !== 401) leaks.push(`${name} -> ${String(res.status)}`);
    }
    expect(leaks).toEqual([]);
  });

  it('shows no project route to somebody who is not a member', async () => {
    const leaks: string[] = [];
    for (const route of routes) {
      if (!route.path.includes(':projectId')) continue;
      const res = await send(app, route, concrete(route.path, victimProject), outsider);
      if (res.status !== 404) leaks.push(`${route.method} ${route.path} -> ${String(res.status)}`);
    }
    expect(leaks).toEqual([]);
  });

  it('leaves the victim project untouched after all of that', async () => {
    const project = await db!.project.findUniqueOrThrow({ where: { id: victimProject } });
    expect(project.name).toBe('Private');
    expect(await db!.projectMember.count({ where: { projectId: victimProject } })).toBe(1);
  });
});
