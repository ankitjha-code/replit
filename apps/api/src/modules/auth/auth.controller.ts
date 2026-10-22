import type { Request, Response } from 'express';
import type {
  AuthenticatedResponse,
  CurrentUserResponse,
  LoginRequest,
  LoginResponse,
  RegisterRequest,
  TwoFactorLoginRequest,
} from '@platform/shared';
import { requireAuthContext } from '../../http/middleware/authenticate.js';
import {
  clearSessionCookie,
  setSessionCookie,
  type SessionCookieSettings,
} from '../../http/session-cookie.js';
import { toPublicUser } from '../users/user.repository.js';
import type { AuthenticationService } from './authentication.service.js';
import type { RegistrationService } from './registration.service.js';
import type { RequestFingerprint, SessionService } from './session.service.js';

/**
 * Translates between HTTP and the auth services.
 *
 * The one thing that genuinely belongs here rather than in a service is the
 * cookie: a service should not know it is being called over HTTP.
 */
export class AuthController {
  constructor(
    private readonly registration: RegistrationService,
    private readonly authentication: AuthenticationService,
    private readonly sessions: SessionService,
    private readonly cookie: SessionCookieSettings,
  ) {}

  register = async (req: Request, res: Response): Promise<void> => {
    const user = await this.registration.register(req.body as RegisterRequest);

    // Signing in immediately after signing up is what a person expects, and
    // the alternative is a form that asks for the same password twice in a
    // row. The session is issued the same way sign-in issues one.
    const issued = await this.sessions.issue(user.id, fingerprint(req));
    setSessionCookie(res, issued.token, this.cookie);

    const body: AuthenticatedResponse = {
      user,
      session: { expiresAt: issued.session.expiresAt.toISOString() },
    };
    res.status(201).json(body);
  };

  login = async (req: Request, res: Response): Promise<void> => {
    const result = await this.authentication.login(req.body as LoginRequest, fingerprint(req));

    // A password alone, for an account with a second factor: no cookie, and a
    // challenge to answer instead.
    if ('challenge' in result) {
      const body: LoginResponse = { twoFactorRequired: true, challenge: result.challenge };
      res.status(200).json(body);
      return;
    }

    setSessionCookie(res, result.issued.token, this.cookie);

    const body: AuthenticatedResponse = {
      user: toPublicUser(result.user),
      session: { expiresAt: result.issued.session.expiresAt.toISOString() },
    };
    res.status(200).json(body);
  };

  loginTwoFactor = async (req: Request, res: Response): Promise<void> => {
    const { challenge, code } = req.body as TwoFactorLoginRequest;
    const result = await this.authentication.completeTwoFactor(challenge, code, fingerprint(req));
    setSessionCookie(res, result.issued.token, this.cookie);

    const body: AuthenticatedResponse = {
      user: toPublicUser(result.user),
      session: { expiresAt: result.issued.session.expiresAt.toISOString() },
    };
    res.status(200).json(body);
  };

  logout = async (req: Request, res: Response): Promise<void> => {
    // Signing out when already signed out is not an error, so this succeeds
    // either way. The cookie is cleared regardless, which is the part the
    // browser cares about.
    if (req.auth) {
      await this.sessions.revoke(req.auth.session.id);
    }
    clearSessionCookie(res, this.cookie);
    res.status(204).end();
  };

  logoutEverywhere = async (req: Request, res: Response): Promise<void> => {
    const { user } = requireAuthContext(req);
    await this.sessions.revokeAllForUser(user.id);
    clearSessionCookie(res, this.cookie);
    res.status(204).end();
  };

  /**
   * Who the caller is, or explicitly nobody.
   *
   * Answering 200 with a null user rather than 401 keeps "not signed in" an
   * ordinary answer, so the client can ask on load without treating the
   * common case as an error.
   */
  me = (req: Request, res: Response): void => {
    const body: CurrentUserResponse = {
      user: req.auth ? toPublicUser(req.auth.user) : null,
    };
    res.status(200).json(body);
  };
}

/**
 * What is recorded alongside a session.
 *
 * Both values are attacker-controlled and are stored for the user's own
 * benefit, so they can see where they are signed in. Neither is ever used to
 * make an authorization decision.
 */
function fingerprint(req: Request): RequestFingerprint {
  return {
    userAgent: req.get('user-agent'),
    ipAddress: req.ip,
  };
}
