import { describe, expect, it, vi } from 'vitest';
import { terminalPath } from '@platform/shared';
import { AppError } from '../errors/app-error.js';
import { authorizeTerminalUpgrade, type UpgradeGuardDependencies } from './upgrade-guard.js';
import { SocketGuard } from './socket-guard.js';
import type { AuthorizationService } from '../modules/projects/authorization.service.js';
import type { SessionService } from '../modules/auth/session.service.js';

const PROJECT = '018f0000-0000-7000-8000-0000000000aa';
const USER = '018f0000-0000-7000-8000-0000000000bb';
const ORIGIN = 'http://localhost:5173';

const sessionsThatAccept = (token: string): SessionService =>
  ({
    resolve: (candidate?: string) =>
      Promise.resolve(
        candidate === token
          ? { user: { id: USER, username: 'someone', displayName: null } }
          : undefined,
      ),
  }) as unknown as SessionService;

const authorizationThatAllows = (): AuthorizationService =>
  ({ authorize: () => Promise.resolve({ role: 'OWNER' }) }) as unknown as AuthorizationService;

const authorizationThatRefuses = (error: AppError): AuthorizationService =>
  ({ authorize: () => Promise.reject(error) }) as unknown as AuthorizationService;

function deps(overrides: Partial<UpgradeGuardDependencies> = {}): UpgradeGuardDependencies {
  return {
    sessions: sessionsThatAccept('good-token'),
    authorization: authorizationThatAllows(),
    cookie: { name: 'platform_session', secure: false, maxAgeMs: 1000 },
    allowedOrigins: [ORIGIN],
    guard: new SocketGuard({
      maxPerUser: 100,
      maxAttempts: 1_000,
      attemptWindowMs: 60_000,
      log: silentLogger(),
    }),
    ...overrides,
  };
}

const request = (
  overrides: {
    url?: string | undefined;
    origin?: string | undefined;
    cookie?: string | undefined;
  } = {},
) => ({
  url: 'url' in overrides ? overrides.url : terminalPath(PROJECT),
  headers: {
    origin: 'origin' in overrides ? overrides.origin : ORIGIN,
    cookie: 'cookie' in overrides ? overrides.cookie : 'platform_session=good-token',
  },
  address: '198.51.100.7',
});

describe('where the connection came from', () => {
  it('accepts a page the platform serves', async () => {
    const decision = await authorizeTerminalUpgrade(deps(), request());
    expect(decision).toMatchObject({
      ok: true,
      userId: USER,
      projectId: PROJECT,
      username: 'someone',
      displayName: null,
      role: 'OWNER',
    });
  });

  it('refuses another site', async () => {
    const decision = await authorizeTerminalUpgrade(
      deps(),
      request({ origin: 'https://evil.example' }),
    );
    expect(decision).toEqual({ ok: false, status: 403, message: 'Origin not allowed' });
  });

  it('refuses a request with no origin at all', async () => {
    const decision = await authorizeTerminalUpgrade(deps(), request({ origin: undefined }));
    expect(decision.ok).toBe(false);
  });

  it('checks the origin before it looks at anything else', async () => {
    const authorization = authorizationThatAllows();
    const spy = vi.spyOn(authorization, 'authorize');

    await authorizeTerminalUpgrade(
      deps({ authorization }),
      request({ origin: 'https://evil.test' }),
    );

    expect(spy).not.toHaveBeenCalled();
  });
});

describe('who is asking', () => {
  it('refuses a caller with no session', async () => {
    const decision = await authorizeTerminalUpgrade(deps(), request({ cookie: undefined }));
    expect(decision).toEqual({
      ok: false,
      status: 401,
      message: 'Authentication required',
    });
  });

  it('refuses a session that does not resolve', async () => {
    const decision = await authorizeTerminalUpgrade(
      deps(),
      request({ cookie: 'platform_session=expired' }),
    );
    expect(decision.ok).toBe(false);
    expect(decision).toMatchObject({ status: 401 });
  });

  it('ignores other cookies around it', async () => {
    const decision = await authorizeTerminalUpgrade(
      deps(),
      request({ cookie: 'theme=dark; platform_session=good-token; other=1' }),
    );
    expect(decision.ok).toBe(true);
  });
});

describe('what they may reach', () => {
  it('refuses a project they cannot see, without saying it exists', async () => {
    const decision = await authorizeTerminalUpgrade(
      deps({
        authorization: authorizationThatRefuses(new AppError('NOT_FOUND', 'Project not found')),
      }),
      request(),
    );
    expect(decision).toEqual({ ok: false, status: 404, message: 'Not found' });
  });

  it('refuses someone whose role does not allow a terminal', async () => {
    const decision = await authorizeTerminalUpgrade(
      deps({
        authorization: authorizationThatRefuses(
          new AppError('FORBIDDEN', 'Your access to this project does not allow that'),
        ),
      }),
      request(),
    );
    expect(decision).toEqual({ ok: false, status: 403, message: 'Forbidden' });
  });

  it('asks for the terminal capability, not merely for read access', async () => {
    const authorization = authorizationThatAllows();
    const spy = vi.spyOn(authorization, 'authorize');

    await authorizeTerminalUpgrade(deps({ authorization }), request());

    expect(spy).toHaveBeenCalledWith(USER, PROJECT, 'terminal:attach');
  });
});

describe('the address', () => {
  it('refuses a path that is not a terminal', async () => {
    for (const url of ['/ws', '/ws/projects//terminal', '/api/projects/x/terminal', undefined]) {
      const decision = await authorizeTerminalUpgrade(deps(), request({ url: url as string }));
      expect(decision.ok).toBe(false);
    }
  });

  it('ignores a query string', async () => {
    const decision = await authorizeTerminalUpgrade(
      deps(),
      request({ url: `${terminalPath(PROJECT)}?rows=40` }),
    );
    expect(decision.ok).toBe(true);
  });

  it('refuses a project identifier smuggled through a traversal', async () => {
    const decision = await authorizeTerminalUpgrade(
      deps(),
      request({ url: '/ws/projects/../../admin/terminal' }),
    );
    expect(decision.ok).toBe(false);
  });
});

function silentLogger() {
  const noop = (): void => undefined;
  return { debug: noop, info: noop, warn: noop, error: noop, fatal: noop, trace: noop } as never;
}
