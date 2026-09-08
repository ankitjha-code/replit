import type { NextFunction, Request, Response } from 'express';
import { AppError, unauthenticated } from '../../errors/app-error.js';
import type { AuthenticatedContext, SessionService } from '../../modules/auth/session.service.js';
import { readSessionCookie, type SessionCookieSettings } from '../session-cookie.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Present only when a valid session cookie accompanied the request. */
      auth?: AuthenticatedContext;
    }
  }
}

/**
 * Resolves the session cookie, if there is one.
 *
 * Never rejects. It answers "who is this, if anyone", and leaves the decision
 * about whether that is good enough to `requireAuth`. Keeping the two apart is
 * what lets a route serve both signed-in and anonymous callers without
 * duplicating the lookup.
 */
export function attachSession(sessions: SessionService, cookie: SessionCookieSettings) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    const token = readSessionCookie(req.cookies as Record<string, string | undefined>, cookie);
    const context = await sessions.resolve(token);
    if (context) req.auth = context;
    next();
  };
}

/**
 * Refuses the request unless a session resolved.
 *
 * This is authentication only: it establishes who the caller is. Whether that
 * caller may touch a particular project is a separate check that happens
 * closer to the resource.
 */
export function requireAuth() {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.auth) {
      next(unauthenticated('You must be signed in to do that'));
      return;
    }
    next();
  };
}

/**
 * Refuses anybody who is not an operator of this installation.
 *
 * Answers **not found**, not forbidden, and the reason is the same one projects
 * follow: a surface that answered "forbidden" would confirm to anybody signed in
 * that an operations area exists here and that they are not in it. There is
 * nothing for them at these paths, and that is what the platform says.
 *
 * Read from the session's user record, which is loaded fresh on every request,
 * so revoking somebody's operator flag takes effect on their next call rather
 * than when their session happens to end.
 */
export function requireOperator() {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.auth?.user.isOperator) {
      next(new AppError('NOT_FOUND', 'Not found'));
      return;
    }
    next();
  };
}

/**
 * The authenticated context, for handlers already behind `requireAuth`.
 *
 * Throws rather than returning undefined: reaching here without a session
 * means the route was assembled wrongly, and that should be loud.
 */
export function requireAuthContext(req: Request): AuthenticatedContext {
  if (!req.auth) {
    throw new Error('requireAuthContext used on a route that is not behind requireAuth');
  }
  return req.auth;
}
