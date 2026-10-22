import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { errorHandler } from './error-handler.js';
import { requestContext } from './request-context.js';
import { validateBody } from './validate.js';

const schema = z.object({
  name: z.string().trim().min(2),
  age: z.coerce.number().int().min(0),
});

const app = () => {
  const server = express();
  server.use(requestContext());
  server.use(express.json());
  server.post('/things', validateBody(schema), (req, res) => {
    res.json({ received: req.body });
  });
  server.use(errorHandler());
  return server;
};

describe('validateBody', () => {
  it('passes a valid body through', async () => {
    const res = await request(app()).post('/things').send({ name: 'Ada', age: 36 }).expect(200);
    expect(res.body.received).toEqual({ name: 'Ada', age: 36 });
  });

  it('replaces the body with the parsed value', async () => {
    const res = await request(app())
      .post('/things')
      .send({ name: '  Ada  ', age: '36' })
      .expect(200);
    // Trimmed and coerced, so the handler cannot receive the raw input.
    expect(res.body.received).toEqual({ name: 'Ada', age: 36 });
  });

  it('strips fields the schema does not declare', async () => {
    const res = await request(app())
      .post('/things')
      .send({ name: 'Ada', age: 36, isAdmin: true })
      .expect(200);
    expect(res.body.received).not.toHaveProperty('isAdmin');
  });

  it('rejects an invalid body as VALIDATION_FAILED', async () => {
    const res = await request(app()).post('/things').send({ name: 'A', age: -1 }).expect(422);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('names the offending fields so a form can show them', async () => {
    const res = await request(app()).post('/things').send({ name: 'A', age: -1 }).expect(422);
    const paths = res.body.error.details.fields.map((f: { path: string }) => f.path);
    expect(paths).toContain('name');
    expect(paths).toContain('age');
  });

  it('rejects a missing body', async () => {
    await request(app()).post('/things').send({}).expect(422);
  });

  it('includes the request id for correlation', async () => {
    const res = await request(app()).post('/things').send({}).expect(422);
    expect(typeof res.body.error.requestId).toBe('string');
  });
});
