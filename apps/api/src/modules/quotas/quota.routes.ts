import { Router, type Request, type Response } from 'express';
import type { QuotaResponse } from '@platform/shared';
import { requireAuthContext } from '../../http/middleware/authenticate.js';
import type { QuotaService } from './quota.service.js';

/**
 * What the signed-in account is using, and what it may use.
 *
 * Not under a project, unlike almost everything else here, because it is not
 * about one: the ceiling is per account, and a page that had to pick a project
 * in order to ask would be asking the wrong question.
 *
 * Answers only about the caller. There is no way to ask about somebody else's
 * usage, which would be a way to learn how much of the platform other people
 * are using.
 */
export function quotaRoutes(options: { quotas: QuotaService }): Router {
  const router = Router();

  router.get('/', async (req: Request, res: Response) => {
    const { user } = requireAuthContext(req);

    const body: QuotaResponse = { quotas: await options.quotas.describe(user.id) };
    res.status(200).json(body);
  });

  return router;
}
