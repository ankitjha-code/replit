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
    rateLimit({
      bucket: 'auth:login',
      store: options.rateLimitStore,
      max: options.loginMax,
      windowMs: options.loginWindowMs,
    }),
    validateBody(loginRequestSchema),
    controller.login,
  );

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

  router.post('/logout', controller.logout);

  router.post('/logout-all', requireAuth(), controller.logoutEverywhere);

  router.get('/me', controller.me);

  const mailing = rateLimit({
    bucket: 'auth:mail',
    store: options.rateLimitStore,
    max: options.mailMax,
    windowMs: options.mailWindowMs,
  });

  router.get('/verification', requireAuth(), verification.status);

  router.post('/verification/send', requireAuth(), mailing, verification.sendVerification);

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

  router.post(
    '/password-reset/complete',
    mailing,
    validateBody(passwordResetCompleteSchema),
    verification.completeReset,
  );

  return router;
}
