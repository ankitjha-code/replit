import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { hashToken } from '../../lib/tokens.js';
import type { MailMessage, MailProvider } from '../../mail/provider.js';
import type { SessionRepository } from '../sessions/session.repository.js';
import type { UserRecord, UserRepository } from '../users/user.repository.js';
import type { AccountTokenRecord, AccountTokenRepository } from './token.repository.js';
import { VerificationService } from './verification.service.js';

const user: UserRecord = {
  id: 'u-1',
  email: 'ada@example.test',
  username: 'ada',
  passwordHash: 'hash',
  displayName: null,
  emailVerifiedAt: null,
  isOperator: false,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function build(options: { users?: UserRecord[]; mailDown?: boolean; sendFails?: boolean } = {}) {
  const tokens = new Map<string, AccountTokenRecord>();
  const sent: MailMessage[] = [];
  const users = options.users ?? [user];
  const verified: string[] = [];
  const signedOut: string[] = [];

  const tokenRepository = {
    create: (input: Omit<AccountTokenRecord, 'id' | 'usedAt' | 'createdAt'>) => {
      const record = { ...input, id: `t-${tokens.size}`, usedAt: null, createdAt: new Date() };
      tokens.set(input.tokenHash, record);
      return Promise.resolve(record);
    },
    findByHash: (hash: string) => Promise.resolve(tokens.get(hash) ?? null),
    markUsed: (id: string, at: Date) => {
      const record = [...tokens.values()].find((token) => token.id === id);
      if (!record || record.usedAt) return Promise.resolve(false);
      record.usedAt = at;
      return Promise.resolve(true);
    },
    invalidateOutstanding: () => Promise.resolve(0),
    countSince: () => Promise.resolve(0),
  } as unknown as AccountTokenRepository;

  const userRepository = {
    findById: (id: string) => Promise.resolve(users.find((u) => u.id === id) ?? null),
    findByEmail: (email: string) => Promise.resolve(users.find((u) => u.email === email) ?? null),
    markEmailVerified: (id: string) => {
      verified.push(id);
      return Promise.resolve();
    },
    updatePasswordHash: () => Promise.resolve(),
  } as unknown as UserRepository;

  const sessions = {
    deleteAllForUser: (id: string) => {
      signedOut.push(id);
      return Promise.resolve(2);
    },
  } as unknown as SessionRepository;

  const mail: MailProvider = {
    name: 'test',
    unavailableReason: () => Promise.resolve(options.mailDown ? 'no mail here' : null),
    send: (message) => {
      if (options.sendFails) return Promise.reject(new Error('relay refused'));
      sent.push(message);
      return Promise.resolve();
    },
  };

  const service = new VerificationService(
    tokenRepository,
    userRepository,
    sessions,
    mail,
    { hash: () => Promise.resolve('new-hash'), verify: vi.fn(), needsRehash: () => false },
    {
      verificationTtlMinutes: 60,
      resetTtlMinutes: 30,
      maxPerWindow: 5,
      windowMinutes: 60,
      publicUrl: 'http://web.test',
    },
    pino({ level: 'silent' }),
  );

  const tokenIn = (message: MailMessage | undefined): string =>
    /token=([A-Za-z0-9_-]+)/.exec(message?.text ?? '')?.[1] ?? '';

  return { service, sent, tokens, verified, signedOut, tokenIn };
}

describe('asking for a reset', () => {
  it.each([
    ['an address with no account', { users: [] }],
    ['an account', {}],
    ['a mail server that is down', { mailDown: true }],
    ['a send that fails', { sendFails: true }],
  ])('answers the same way for %s', async (_label, options) => {
    // The whole security argument for the endpoint: no difference an outsider
    // can observe, or it becomes a way to learn who has an account here.
    const { service } = build(options);
    await expect(service.requestReset('ada@example.test')).resolves.toBeUndefined();
  });

  it('sends a link to the platform, never to the API', async () => {
    const { service, sent } = build();
    await service.requestReset('ada@example.test');
    expect(sent[0]?.text).toContain('http://web.test/reset-password?token=');
  });
});

describe('completing a reset', () => {
  it('ends every session and verifies the address it was sent to', async () => {
    const { service, sent, signedOut, verified, tokenIn } = build();
    await service.requestReset('ada@example.test');

    await service.completeReset(tokenIn(sent[0]), 'a-new-long-password');

    expect(signedOut).toEqual(['u-1']);
    expect(verified).toEqual(['u-1']);
  });

  it('refuses the same link twice', async () => {
    const { service, sent, tokenIn } = build();
    await service.requestReset('ada@example.test');
    const token = tokenIn(sent[0]);

    await service.completeReset(token, 'a-new-long-password');
    await expect(service.completeReset(token, 'another-long-password')).rejects.toThrow(
      'already been used',
    );
  });

  it('refuses a verification link offered as a reset', async () => {
    // The kind column exists only for this: a link that proves an address must
    // never be able to set a password.
    const { service, sent, tokenIn } = build();
    await service.sendVerification('u-1');

    await expect(service.completeReset(tokenIn(sent[0]), 'a-new-long-password')).rejects.toThrow(
      'not valid',
    );
  });

  it('refuses something that cannot be one of ours without looking it up', async () => {
    const { service } = build();
    await expect(service.completeReset('nope', 'a-new-long-password')).rejects.toThrow('not valid');
  });
});

describe('verifying an address', () => {
  it('proves the address the link was sent to, not whatever the account says now', async () => {
    const account = { ...user };
    const { service, sent, verified, tokenIn } = build({ users: [account] });
    await service.sendVerification('u-1');

    // The address changes after the message went out.
    account.email = 'someone-else@example.test';

    await expect(service.confirmVerification(tokenIn(sent[0]))).rejects.toThrow(
      'different address',
    );
    expect(verified).toEqual([]);
  });

  it('refuses an address that is already verified', async () => {
    const { service } = build({ users: [{ ...user, emailVerifiedAt: new Date() }] });
    await expect(service.sendVerification('u-1')).rejects.toThrow('already verified');
  });

  it('refuses plainly when mail cannot be sent, rather than storing a token', async () => {
    const { service, tokens } = build({ mailDown: true });
    await expect(service.sendVerification('u-1')).rejects.toThrow('no mail here');
    expect(tokens.size).toBe(0);
  });

  it('stores only a hash of the link', async () => {
    const { service, sent, tokens, tokenIn } = build();
    await service.sendVerification('u-1');
    const token = tokenIn(sent[0]);

    expect(tokens.has(hashToken(token))).toBe(true);
    expect([...tokens.keys()]).not.toContain(token);
  });
});
