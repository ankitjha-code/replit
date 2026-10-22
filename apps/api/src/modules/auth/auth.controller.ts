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

export class AuthController {
  constructor(
    private readonly registration: RegistrationService,
    private readonly authentication: AuthenticationService,
    private readonly sessions: SessionService,
    private readonly cookie: SessionCookieSettings,
  ) {}

  register = async (req: Request, res: Response): Promise<void> => {
    const user = await this.registration.register(req.body as RegisterRequest);

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

  me = (req: Request, res: Response): void => {
    const body: CurrentUserResponse = {
      user: req.auth ? toPublicUser(req.auth.user) : null,
    };
    res.status(200).json(body);
  };
}

function fingerprint(req: Request): RequestFingerprint {
  return {
    userAgent: req.get('user-agent'),
    ipAddress: req.ip,
  };
}
