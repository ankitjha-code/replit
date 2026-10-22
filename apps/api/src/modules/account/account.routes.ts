import { Router } from 'express';
import {
  changePasswordRequestSchema,
  deleteAccountRequestSchema,
  twoFactorConfirmRequestSchema,
  twoFactorDisableRequestSchema,
} from '@platform/shared';
import type { TwoFactorService } from '../two-factor/two-factor.service.js';
import { requireAuthContext } from '../../http/middleware/authenticate.js';
import { requireAuth } from '../../http/middleware/authenticate.js';
import { rateLimit, type RateLimitStore } from '../../http/middleware/rate-limit.js';
import { validateBody } from '../../http/middleware/validate.js';
import type { SessionCookieSettings } from '../../http/session-cookie.js';
import { AccountController } from './account.controller.js';
import type { AccountService } from './account.service.js';

export interface AccountRouteOptions {
  account: AccountService;
  twoFactor: TwoFactorService;
  cookie: SessionCookieSettings;
  rateLimitStore: RateLimitStore;
  sensitiveMax: number;
  sensitiveWindowMs: number;
}

export function accountRoutes(options: AccountRouteOptions): Router {
  const controller = new AccountController(options.account, options.cookie);
  const router = Router();

  const sensitive = rateLimit({
    bucket: 'account:sensitive',
    store: options.rateLimitStore,
    max: options.sensitiveMax,
    windowMs: options.sensitiveWindowMs,
  });

  router.use(requireAuth());

  router.get('/sessions', controller.listSessions);

  router.delete('/sessions/:sessionId', controller.revokeSession);

  router.post('/sessions/revoke-others', controller.revokeOthers);

  router.post(
    '/password',
    sensitive,
    validateBody(changePasswordRequestSchema),
    controller.changePassword,
  );

  router.delete('/', sensitive, validateBody(deleteAccountRequestSchema), controller.deleteAccount);

  router.get('/two-factor', async (req, res) => {
    const { user } = requireAuthContext(req);
    res.status(200).json(await options.twoFactor.status(user.id));
  });

  router.post('/two-factor/setup', sensitive, async (req, res) => {
    const { user } = requireAuthContext(req);
    res.status(200).json(await options.twoFactor.beginEnrolment(user.id));
  });

  router.post(
    '/two-factor/confirm',
    sensitive,
    validateBody(twoFactorConfirmRequestSchema),
    async (req, res) => {
      const { user } = requireAuthContext(req);
      const { code } = req.body as { code: string };
      res.status(200).json(await options.twoFactor.confirmEnrolment(user.id, code));
    },
  );

  router.post(
    '/two-factor/disable',
    sensitive,
    validateBody(twoFactorDisableRequestSchema),
    async (req, res) => {
      const { user } = requireAuthContext(req);
      await options.twoFactor.disable(user.id, req.body as { password: string; code: string });
      res.status(204).end();
    },
  );

  return router;
}
