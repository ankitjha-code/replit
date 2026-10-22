import { Router } from 'express';
import {
  confirmTokenRequestSchema,
  loginRequestSchema,
  passwordResetCompleteSchema,
  passwordResetRequestSchema,
  registerRequestSchema,
  twoFactorLoginRequestSchema,
} from '@platform/shared';
import { requireAuth } from '../../http/middleware/authenticate.js';
import { rateLimit, type RateLimitStore } from '../../http/middleware/rate-limit.js';
import { validateBody } from '../../http/middleware/validate.js';
import type { SessionCookieSettings } from '../../http/session-cookie.js';
import { AuthController } from './auth.controller.js';
import type { AuthenticationService } from './authentication.service.js';
import type { RegistrationService } from './registration.service.js';
import type { SessionService } from './session.service.js';
import { VerificationController } from '../verification/verification.controller.js';
import type { VerificationService } from '../verification/verification.service.js';

export interface AuthRouteOptions {
  registration: RegistrationService;
  authentication: AuthenticationService;
  sessions: SessionService;
  cookie: SessionCookieSettings;
  rateLimitStore: RateLimitStore;
  registerMax: number;
  registerWindowMs: number;
  loginMax: number;
  loginWindowMs: number;
  verification: VerificationService;
  /** Attempts at anything that causes a message to be sent, per window. */
  mailMax: number;
  mailWindowMs: number;
}

export function authRoutes(options: AuthRouteOptions): Router {
  const controller = new AuthController(
    options.registration,
    options.authentication,
    options.sessions,
    options.cookie,
  );
  const verification = new VerificationController(options.verification, options.cookie);
  const router = Router();

  // Middleware order is deliberate throughout: the limiter runs before
  // validation, so a flood of malformed bodies is cheap to reject, and
  // validation runs before any service, so nothing reaches key derivation
  // without a valid shape.

  router.post(
    '/register',
    rateLimit({
      bucket: 'auth:register',
      store: options.rateLimitStore,
      max: options.registerMax,
      windowMs: options.registerWindowMs,
    }),
    validateBody(registerRequestSchema),
    controller.register,
  );

  router.post(
    '/login',
    // Its own bucket, so exhausting sign-in attempts does not also block
    // sign-up from the same address, and vice versa.
    rateLimit({
      bucket: 'auth:login',
      store: options.rateLimitStore,
      max: options.loginMax,
      windowMs: options.loginWindowMs,
    }),
    validateBody(loginRequestSchema),
    controller.login,
  );

  /*
   * The second half of signing in, for an account with a second factor.
   *
   * The sign-in limiter again, sharing its bucket: guessing codes is the same
   * kind of attack as guessing passwords, and the challenge's own attempt limit
   * stops one challenge being walked while this stops many being opened.
   */
  router.post(
    '/login/two-factor',
    rateLimit({
      bucket: 'auth:login',
      store: options.rateLimitStore,
      max: options.loginMax,
      windowMs: options.loginWindowMs,
    }),
    validateBody(twoFactorLoginRequestSchema),
    controller.loginTwoFactor,
  );

  // Not behind requireAuth: signing out without a session is a no-op that
  // still clears the cookie, which is what a confused browser needs.
  router.post('/logout', controller.logout);

  router.post('/logout-all', requireAuth(), controller.logoutEverywhere);

  router.get('/me', controller.me);

  /*
   * Anything that sends a message shares one bucket, tighter than sign-in's.
   *
   * These endpoints cost more than a request: each one puts a message in
   * somebody's inbox, and the person receiving it is not the person making the
   * request. That is what separates a rate limit here from a rate limit
   * elsewhere — without one, the endpoint is a way to send mail to a stranger
   * repeatedly, using this platform's reputation to do it.
   *
   * The service applies a second ceiling per account, because this one is per
   * address and many clients can point at one person.
   */
  const mailing = rateLimit({
    bucket: 'auth:mail',
    store: options.rateLimitStore,
    max: options.mailMax,
    windowMs: options.mailWindowMs,
  });

  router.get('/verification', requireAuth(), verification.status);

  router.post('/verification/send', requireAuth(), mailing, verification.sendVerification);

  /*
   * Not behind requireAuth, deliberately.
   *
   * A verification link is opened from an inbox, which is often not the browser
   * that is signed in — a phone, a different machine, a private window. The
   * token is the proof; requiring a session as well would make the link fail
   * exactly where it is most likely to be used.
   */
  router.post(
    '/verification/confirm',
    mailing,
    validateBody(confirmTokenRequestSchema),
    verification.confirmVerification,
  );

  router.post(
    '/password-reset',
    mailing,
    validateBody(passwordResetRequestSchema),
    verification.requestReset,
  );

  /*
   * The limiter here is about guessing, not about sending.
   *
   * Nothing is mailed by this route. What it protects is the token: without a
   * ceiling, an attacker can try reset codes as fast as the server will answer.
   * The tokens are 256-bit random, so this is defence in depth rather than the
   * thing standing between an account and a stranger.
   */
  router.post(
    '/password-reset/complete',
    mailing,
    validateBody(passwordResetCompleteSchema),
    verification.completeReset,
  );

  return router;
}
