import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config/env.js';
import { codeFor, stepAt } from '../src/lib/totp.js';
import { createTestClient, resetDatabase, testDatabaseUrl } from './setup/database.js';
import { FakePasswordHasher, silentLogger, testApp, testAuth } from './setup/app.js';
import type { PrismaClient } from '../src/generated/prisma/index.js';

/**
 * Two-factor sign-in through the real stack and the real database.
 *
 * Codes are computed here from the secret the setup returned, exactly as an
 * authenticator app would, so nothing about the check is faked.
 */

const url = testDatabaseUrl();
const db: PrismaClient | undefined = url ? createTestClient(url) : undefined;
const KEY = randomBytes(32).toString('base64');
const ada = { email: 'ada@example.test', username: 'ada', password: 'analytical-engine-1843' };

afterAll(async () => {
  await db?.$disconnect();
});

function base32Decode(text: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const character of text) {
    value = (value << 5) | alphabet.indexOf(character);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A code for a step that has not been used yet, as an app would show it. */
function code(secret: Buffer, offset = 0): string {
  return codeFor(secret, stepAt(new Date()) + offset);
}

async function enrolled() {
  const hasher = new FakePasswordHasher();
  const config = loadEnv({
    RATE_LIMIT_REGISTER_MAX: '100',
    RATE_LIMIT_LOGIN_MAX: '100',
    RATE_LIMIT_ACCOUNT_MAX: '100',
    SECRETS_ENCRYPTION_KEY: KEY,
  } as NodeJS.ProcessEnv);
  const auth = testAuth(db!, config, hasher, silentLogger());
  const app = testApp({ config, passwordHasher: hasher, auth });

  const registered = await request(app).post('/api/auth/register').send(ada).expect(201);
  const cookie = (registered.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;

  const setup = await request(app)
    .post('/api/account/two-factor/setup')
    .set('Cookie', cookie)
    .expect(200);
  expect(setup.body.uri).toMatch(/^otpauth:\/\/totp\//);
  const secret = base32Decode(setup.body.secret as string);

  const confirmed = await request(app)
    .post('/api/account/two-factor/confirm')
    .set('Cookie', cookie)
    .send({ code: code(secret, -1) })
    .expect(200);

  return { app, cookie, secret, recoveryCodes: confirmed.body.recoveryCodes as string[] };
}

const login = (app: Awaited<ReturnType<typeof enrolled>>['app']) =>
  request(app).post('/api/auth/login').send({ identifier: ada.email, password: ada.password });

describe.skipIf(!db)('two-factor sign-in', () => {
  beforeEach(async () => {
    await resetDatabase(db!);
  });

  it('turns on only after a correct code, and hands out recovery codes once', async () => {
    const w = await enrolled();
    expect(w.recoveryCodes).toHaveLength(10);
    const status = await request(w.app)
      .get('/api/account/two-factor')
      .set('Cookie', w.cookie)
      .expect(200);
    expect(status.body).toMatchObject({ enabled: true, recoveryCodesLeft: 10 });
  });

  it('gives a password alone no session — only a challenge', async () => {
    const w = await enrolled();
    const res = await login(w.app).expect(200);

    expect(res.body).toMatchObject({ twoFactorRequired: true });
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('signs in with the password and then a current code', async () => {
    const w = await enrolled();
    const { challenge } = (await login(w.app).expect(200)).body as { challenge: string };

    const done = await request(w.app)
      .post('/api/auth/login/two-factor')
      .send({ challenge, code: code(w.secret) })
      .expect(200);
    expect((done.headers['set-cookie'] as unknown as string[])[0]).toMatch(/^platform_session=/);
  });

  it('refuses a code that has already been used', async () => {
    const w = await enrolled();
    const used = code(w.secret, 1);

    const first = (await login(w.app).expect(200)).body.challenge as string;
    await request(w.app)
      .post('/api/auth/login/two-factor')
      .send({ challenge: first, code: used })
      .expect(200);

    const second = (await login(w.app).expect(200)).body.challenge as string;
    await request(w.app)
      .post('/api/auth/login/two-factor')
      .send({ challenge: second, code: used })
      .expect(401);
  });

  it('burns a challenge after five wrong codes, even if the sixth is right', async () => {
    const w = await enrolled();
    const { challenge } = (await login(w.app).expect(200)).body as { challenge: string };

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await request(w.app)
        .post('/api/auth/login/two-factor')
        .send({ challenge, code: '000000' })
        .expect(401);
    }
    await request(w.app)
      .post('/api/auth/login/two-factor')
      .send({ challenge, code: code(w.secret) })
      .expect(401);
  });

  it('accepts a recovery code once, and only once', async () => {
    const w = await enrolled();
    const recovery = w.recoveryCodes[0]!;

    const first = (await login(w.app).expect(200)).body.challenge as string;
    await request(w.app)
      .post('/api/auth/login/two-factor')
      .send({ challenge: first, code: recovery })
      .expect(200);

    const second = (await login(w.app).expect(200)).body.challenge as string;
    await request(w.app)
      .post('/api/auth/login/two-factor')
      .send({ challenge: second, code: recovery })
      .expect(401);
  });

  it('needs the password and a code to turn it off', async () => {
    const w = await enrolled();

    await request(w.app)
      .post('/api/account/two-factor/disable')
      .set('Cookie', w.cookie)
      .send({ password: 'wrong', code: code(w.secret, 1) })
      .expect(422);

    await request(w.app)
      .post('/api/account/two-factor/disable')
      .set('Cookie', w.cookie)
      .send({ password: ada.password, code: code(w.secret, 1) })
      .expect(204);

    // And then a password is enough again.
    const res = await login(w.app).expect(200);
    expect(res.body.twoFactorRequired).toBeUndefined();
  });

  it('never stores the secret or a recovery code in the clear', async () => {
    const w = await enrolled();
    const row = await db!.user.findUniqueOrThrow({ where: { username: 'ada' } });
    const codes = await db!.totpRecoveryCode.findMany();

    expect(Buffer.from(row.totpSecret!).toString('latin1')).not.toContain(
      w.secret.toString('latin1'),
    );
    expect(codes.map((c) => c.codeHash)).not.toContain(w.recoveryCodes[0]);
  });
});
