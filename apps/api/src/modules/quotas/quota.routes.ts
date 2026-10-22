import { Router, type Request, type Response } from 'express';
import type { QuotaResponse } from '@platform/shared';
import { requireAuthContext } from '../../http/middleware/authenticate.js';
import type { QuotaService } from './quota.service.js';

export function quotaRoutes(options: { quotas: QuotaService }): Router {
  const router = Router();

  router.get('/', async (req: Request, res: Response) => {
    const { user } = requireAuthContext(req);

    const body: QuotaResponse = { quotas: await options.quotas.describe(user.id) };
    res.status(200).json(body);
  });

  return router;
}
