import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { healthResponseSchema } from '@platform/shared';
import { testApp, testDependencies } from './setup/app.js';

const app = () => testApp();

describe('HTTP baseline', () => {
  it('answers liveness', async () => {
    const res = await request(app()).get('/health/live').expect(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.service).toBe('api');
  });

  it('answers readiness in the shared contract shape', async () => {
    const res = await request(app()).get('/health/ready').expect(200);
    expect(() => healthResponseSchema.parse(res.body)).not.toThrow();
  });

  it('reports a dependency failure as 503', async () => {
    const deps = testDependencies();
    deps.health.register({
      name: 'db',
      check: () => Promise.resolve({ status: 'down' as const, detail: 'not configured' }),
    });
    const res = await request(testApp(deps)).get('/health/ready').expect(503);
    expect(res.body.status).toBe('down');
  });

  it('returns the structured error envelope for an unknown route', async () => {
    const res = await request(app()).get('/does-not-exist').expect(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(typeof res.body.error.requestId).toBe('string');
  });

  it('echoes a request id on every response', async () => {
    const res = await request(app()).get('/health/live').expect(200);
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('propagates a well-formed upstream request id', async () => {
    const res = await request(app())
      .get('/health/live')
      .set('x-request-id', 'trace-abc-123')
      .expect(200);
    expect(res.headers['x-request-id']).toBe('trace-abc-123');
  });

  it('replaces a hostile upstream request id', async () => {
    const res = await request(app())
      .get('/health/live')
      .set('x-request-id', 'bad id with spaces')
      .expect(200);
    expect(res.headers['x-request-id']).not.toBe('bad id with spaces');
  });

  it('does not advertise the server framework', async () => {
    const res = await request(app()).get('/health/live').expect(200);
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('sets baseline security headers', async () => {
    const res = await request(app()).get('/health/live').expect(200);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('rejects a body over the size limit', async () => {
    await request(app())
      .post('/health/live')
      .set('content-type', 'application/json')
      .send(JSON.stringify({ blob: 'x'.repeat(2 * 1024 * 1024) }))
      .expect(413);
  });
});
