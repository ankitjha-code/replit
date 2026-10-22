import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import type { PasswordHasher } from '../../lib/password.js';
import type { ProjectRepository } from '../projects/project.repository.js';
import type { ProjectService } from '../projects/project.service.js';
import type { SessionRecord, SessionRepository } from '../sessions/session.repository.js';
import type { UserRecord, UserRepository } from '../users/user.repository.js';
import { AccountService } from './account.service.js';

const user: UserRecord = {
  id: 'u-1',
  email: 'ada@example.test',
  username: 'Ada',
  passwordHash: 'right',
  displayName: null,
  emailVerifiedAt: null,
  isOperator: false,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function session(id: string, userId = 'u-1'): SessionRecord {
  return {
    id,
    userId,
    tokenHash: `hash-${id}`,
    expiresAt: new Date(Date.now() + 60_000),
    lastSeenAt: new Date(),
    userAgent: 'Mozilla/5.0 (Macintosh; Mac OS X) Chrome/130',
    ipAddress: '198.51.100.7',
    createdAt: new Date(),
  };
}

function build(options: { owned?: string[]; withProjects?: boolean; failOn?: string } = {}) {
  const events: string[] = [];
  let sessions = [session('s-current'), session('s-other'), session('s-foreign', 'u-2')];

  const users = {
    findById: (id: string) => Promise.resolve(id === 'u-1' ? user : null),
    updatePasswordHash: () => {
      events.push('password-changed');
      return Promise.resolve();
    },
    deleteById: (id: string) => {
      events.push(`user-deleted:${id}`);
      return Promise.resolve();
    },
  } as unknown as UserRepository;

  const sessionRepository = {
    listForUser: (userId: string) => Promise.resolve(sessions.filter((s) => s.userId === userId)),
    findOwned: (id: string, userId: string) =>
      Promise.resolve(sessions.find((s) => s.id === id && s.userId === userId) ?? null),
    deleteById: (id: string) => {
      sessions = sessions.filter((s) => s.id !== id);
      return Promise.resolve();
    },
    deleteAllForUserExcept: (userId: string, keep: string) => {
      const before = sessions.length;
      sessions = sessions.filter((s) => s.userId !== userId || s.id === keep);
      return Promise.resolve(before - sessions.length);
    },
  } as unknown as SessionRepository;

  const projects = {
    listOwnedIds: () => Promise.resolve(options.owned ?? []),
  } as unknown as ProjectRepository;

  const hasher: PasswordHasher = {
    hash: () => Promise.resolve('new'),
    verify: (hash, plain) => Promise.resolve(hash === plain),
    needsRehash: () => false,
  };

  const service = new AccountService(
    users,
    sessionRepository,
    projects,
    hasher,
    { wrongPasswordDelayMs: 0 },
    pino({ level: 'silent' }),
  );

  if (options.withProjects !== false) {
    service.useProjects({
      delete: (projectId: string) => {
        if (projectId === options.failOn) return Promise.reject(new Error('host unreachable'));
        events.push(`project-deleted:${projectId}`);
        return Promise.resolve();
      },
    } as unknown as ProjectService);
  }

  return { service, events, sessions: () => sessions };
}

describe('closing an account', () => {
  it('deletes every owned project through the project service before the account', async () => {
    // The users row cascades to projects. Deleting it first would succeed and
    // abandon every container, database and archive those projects held.
    const { service, events } = build({ owned: ['p-1', 'p-2'] });

    await service.deleteAccount('u-1', { password: 'right', confirmUsername: 'ada' });

    expect(events).toEqual(['project-deleted:p-1', 'project-deleted:p-2', 'user-deleted:u-1']);
  });

  it('stops entirely when one project cannot be deleted, keeping the account', async () => {
    const { service, events } = build({ owned: ['p-1', 'p-2'], failOn: 'p-2' });

    await expect(
      service.deleteAccount('u-1', { password: 'right', confirmUsername: 'ada' }),
    ).rejects.toThrow('host unreachable');
    expect(events).not.toContain('user-deleted:u-1');
  });

  it('refuses rather than proceeding halfway when projects cannot be released', async () => {
    const { service, events } = build({ owned: ['p-1'], withProjects: false });
    await expect(
      service.deleteAccount('u-1', { password: 'right', confirmUsername: 'ada' }),
    ).rejects.toThrow('cannot be closed');
    expect(events).toEqual([]);
  });

  it('needs the password and the username, and ignores the username’s case', async () => {
    const { service } = build();
    await expect(
      service.deleteAccount('u-1', { password: 'wrong', confirmUsername: 'ada' }),
    ).rejects.toThrow('not your password');
    await expect(
      service.deleteAccount('u-1', { password: 'right', confirmUsername: 'bob' }),
    ).rejects.toThrow('Type your username');
    await expect(
      service.deleteAccount('u-1', { password: 'right', confirmUsername: '  ADA ' }),
    ).resolves.toEqual({ projectsDeleted: 0 });
  });
});

describe('changing a password', () => {
  it('signs out every other session and keeps this one', async () => {
    const { service, sessions } = build();
    const result = await service.changePassword('u-1', 's-current', {
      currentPassword: 'right',
      newPassword: 'a-new-long-password',
      signOutOthers: true,
    });

    expect(result.signedOut).toBe(1);
    expect(sessions().map((s) => s.id)).toEqual(['s-current', 's-foreign']);
  });

  it('leaves the others alone when asked to', async () => {
    const { service, sessions } = build();
    await service.changePassword('u-1', 's-current', {
      currentPassword: 'right',
      newPassword: 'a-new-long-password',
      signOutOthers: false,
    });
    expect(sessions()).toHaveLength(3);
  });

  it('refuses without the current password, and changes nothing', async () => {
    const { service, events } = build();
    await expect(
      service.changePassword('u-1', 's-current', {
        currentPassword: 'wrong',
        newPassword: 'a-new-long-password',
        signOutOthers: true,
      }),
    ).rejects.toThrow('not your current password');
    expect(events).toEqual([]);
  });
});

describe('sessions', () => {
  it('lists only this account’s, with no credential in them, and marks the current one', async () => {
    const { service } = build();
    const listed = await service.listSessions('u-1', 's-current');

    expect(listed.map((s) => s.id)).toEqual(['s-current', 's-other']);
    expect(listed.find((s) => s.current)?.id).toBe('s-current');
    expect(JSON.stringify(listed)).not.toContain('hash-');
  });

  it('answers not found for somebody else’s session, and does not end it', async () => {
    const { service, sessions } = build();
    await expect(service.revokeSession('u-1', 's-current', 's-foreign')).rejects.toThrow(
      'no longer exists',
    );
    expect(sessions().map((s) => s.id)).toContain('s-foreign');
  });

  it('reports whether the session ended was the one asking', async () => {
    const { service } = build();
    await expect(service.revokeSession('u-1', 's-current', 's-other')).resolves.toEqual({
      wasCurrent: false,
    });
    await expect(service.revokeSession('u-1', 's-current', 's-current')).resolves.toEqual({
      wasCurrent: true,
    });
  });
});
