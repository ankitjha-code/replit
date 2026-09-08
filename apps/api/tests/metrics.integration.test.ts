import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config/env.js';
import { MetricsRepository } from '../src/modules/metrics/metrics.repository.js';
import { MetricsService } from '../src/modules/metrics/metrics.service.js';
import { createTestClient, resetDatabase, testDatabaseUrl } from './setup/database.js';
import { FakePasswordHasher, silentLogger, testApp, testAuth } from './setup/app.js';
import type { PrismaClient } from '../src/generated/prisma/index.js';

/** The platform's own metrics page, against the real database. */

const url = testDatabaseUrl();
const db: PrismaClient | undefined = url ? createTestClient(url) : undefined;
const TOKEN = 'metrics-token-for-tests-only-0123456789';

function build(token: string | null = TOKEN) {
  const hasher = new FakePasswordHasher();
  const config = loadEnv({
    RATE_LIMIT_REGISTER_MAX: '100',
    ...(token ? { METRICS_TOKEN: token } : {}),
  } as NodeJS.ProcessEnv);
  const auth = testAuth(db!, config, hasher, silentLogger());
  const metrics = new MetricsService(new MetricsRepository(db! as never));
  return testApp({ config, passwordHasher: hasher, auth, metrics });
}

afterAll(async () => {
  await db?.$disconnect();
});

describe.skipIf(!db)('the metrics page', () => {
  beforeEach(async () => {
    await resetDatabase(db!);
  });

  it('reports requests by route pattern, and platform counts from the database', async () => {
    const app = build();
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'ada@example.test', username: 'ada', password: 'analytical-engine-1843' })
      .expect(201);
    const cookie = (res.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;
    const project = await request(app)
      .post('/api/projects')
      .set('Cookie', cookie)
      .send({ name: 'M' })
      .expect(201);
    await request(app)
      .get(`/api/projects/${project.body.project.id}`)
      .set('Cookie', cookie)
      .expect(200);

    const scraped = await request(app)
      .get('/metrics')
      .set('Authorization', `Bearer ${TOKEN}`)
      .expect(200);

    expect(scraped.headers['content-type']).toContain('text/plain');
    expect(scraped.text).toContain('platform_users 1');
    expect(scraped.text).toContain('platform_projects 1');
    expect(scraped.text).toMatch(
      /platform_http_requests_total\{method="POST",route="\/api\/auth\/register",status="201"\} 1/,
    );
    // A route pattern, never a real identifier.
    expect(scraped.text).toContain('route="/api/projects/:projectId"');
    expect(scraped.text).not.toContain(project.body.project.id as string);
    expect(scraped.text).toContain('platform_process_resident_memory_bytes');
  });

  it('answers not found without the token, with the wrong one, or when none is configured', async () => {
    await request(build()).get('/metrics').expect(404);
    await request(build()).get('/metrics').set('Authorization', 'Bearer wrong').expect(404);
    await request(build(null)).get('/metrics').set('Authorization', `Bearer ${TOKEN}`).expect(404);
  });

  it('refuses a token too short to be one', () => {
    expect(() => loadEnv({ METRICS_TOKEN: 'short' } as NodeJS.ProcessEnv)).toThrow();
  });
});
