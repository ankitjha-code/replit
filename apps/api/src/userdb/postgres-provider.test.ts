import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { PostgresUserDatabaseProvider } from './postgres-provider.js';
import { UnavailableUserDatabaseProvider } from './unavailable-provider.js';

const silent = pino({ level: 'silent' });

const provider = new PostgresUserDatabaseProvider(
  { adminUrl: 'postgresql://nobody:nothing@127.0.0.1:1/postgres', availabilityTtlMs: 0 },
  silent,
);

const GOOD = {
  name: 'p_0123456789abcdef0123456789abcdef',
  role: 'r_0123456789abcdef0123456789abcdef',
};

describe('identifiers it will not use', () => {
  const bad = [
    'p_x; DROP DATABASE platform',
    'p_x"',
    'P_UPPER',
    '1_leading_digit',
    'has-dash',
    'has space',
    '',
    `p_${'x'.repeat(70)}`,
  ];

  for (const name of bad) {
    it(`refuses a database name of ${JSON.stringify(name)}`, async () => {
      await expect(
        provider.provision({ ...GOOD, name, password: 'abcdefghijklmnop' }),
      ).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
    });

    it(`refuses a role name of ${JSON.stringify(name)}`, async () => {
      await expect(
        provider.provision({ ...GOOD, role: name, password: 'abcdefghijklmnop' }),
      ).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
    });
  }

  it('refuses them when dropping too, not only when creating', async () => {
    await expect(provider.drop({ name: 'x"; DROP', role: GOOD.role })).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
    });
  });

  it('says nothing about the value it rejected', async () => {
    const error: unknown = await provider
      .provision({ ...GOOD, name: 'secret_looking_name', password: 'abcdefghijklmnop' })
      .then(() => undefined)
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain('secret_looking_name');
  });
});

describe('passwords it will not use', () => {
  const bad = ["has'quote", 'has"quote', 'has space', 'short', 'has;semicolon'];

  for (const password of bad) {
    it(`refuses ${JSON.stringify(password)}`, async () => {
      await expect(provider.provision({ ...GOOD, password })).rejects.toMatchObject({
        code: 'INTERNAL_ERROR',
      });
    });
  }
});

describe('an installation with no server', () => {
  const none = new UnavailableUserDatabaseProvider();

  it('says why rather than pretending', async () => {
    await expect(none.unavailableReason()).resolves.toMatch(/no database server configured/i);
  });

  it('refuses to provision', async () => {
    await expect(none.provision({ ...GOOD, password: 'abcdefghijklmnop' })).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
    });
  });

  it('succeeds at dropping, so a project stays deletable', async () => {
    await expect(none.drop()).resolves.toBeUndefined();
  });
});
