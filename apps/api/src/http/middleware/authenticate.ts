import type { NextFunction, Request, Response } from 'express';
import { AppError, unauthenticated } from '../../errors/app-error.js';
import type { AuthenticatedContext, SessionService } from '../../modules/auth/session.service.js';
import { readSessionCookie, type SessionCookieSettings } from '../session-cookie.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthenticatedContext;
    }
  }
}

export function attachSession(sessions: SessionService, cookie: SessionCookieSettings) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    const token = readSessionCookie(req.cookies as Record<string, string | undefined>, cookie);
    const context = await sessions.resolve(token);
    if (context) req.auth = context;
    next();
  };
}

export function requireAuth() {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.auth) {
      next(unauthenticated('You must be signed in to do that'));
      return;
    }
    next();
  };
}

export function requireOperator() {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.auth?.user.isOperator) {
      next(new AppError('NOT_FOUND', 'Not found'));
      return;
    }
    next();
  };
}

export function requireAuthContext(req: Request): AuthenticatedContext {
  if (!req.auth) {
    throw new Error('requireAuthContext used on a route that is not behind requireAuth');
  }
  return req.auth;
}
