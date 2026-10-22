import { Router, type Request, type Response } from 'express';
import {
  DOMAIN_VERIFICATION_PREFIX,
  addCustomDomainRequestSchema,
  setDeploymentSubdomainRequestSchema,
  type AddCustomDomainRequest,
  type CustomDomainListResponse,
  type CustomDomainResponse,
  type SetDeploymentSubdomainRequest,
} from '@platform/shared';
import { AppError } from '../../errors/app-error.js';
import {
  requireProjectPermission,
  requireProjectAccess,
} from '../../http/middleware/authorize-project.js';
import { validateBody } from '../../http/middleware/validate.js';
import type { AuthorizationService } from '../projects/authorization.service.js';
import type { DomainService } from './domain.service.js';

export function domainRoutes(options: {
  domains: DomainService;
  authorization: AuthorizationService;
}): Router {
  const guard = (permission: Parameters<typeof requireProjectPermission>[1]) =>
    requireProjectPermission(options.authorization, permission);

  const router = Router({ mergeParams: true });

  router.get('/', guard('deployment:read'), async (req: Request, res: Response) => {
    const { project } = requireProjectAccess(req);

    const address = await options.domains.addressOf(project.id);

    const body: CustomDomainListResponse = {
      domains: await options.domains.list(project.id),
      subdomain: address?.subdomain ?? null,
      target: await options.domains.target(project.id),
      verificationPrefix: DOMAIN_VERIFICATION_PREFIX,
      unavailableReason: options.domains.customDomainsUnavailableReason,
      limit: options.domains.limit,
    };
    res.status(200).json(body);
  });

  router.put(
    '/subdomain',
    guard('deployment:control'),
    validateBody(setDeploymentSubdomainRequestSchema),
    async (req: Request, res: Response) => {
      const { project } = requireProjectAccess(req);
      const { subdomain } = req.body as SetDeploymentSubdomainRequest;

      await options.domains.setSubdomain(project.id, subdomain);
      const address = await options.domains.addressOf(project.id);

      res.status(200).json({ subdomain, url: address?.url ?? null });
    },
  );

  router.post(
    '/',
    guard('deployment:control'),
    validateBody(addCustomDomainRequestSchema),
    async (req: Request, res: Response) => {
      const { project } = requireProjectAccess(req);
      const { hostname } = req.body as AddCustomDomainRequest;

      const body: CustomDomainResponse = {
        domain: await options.domains.add(project.id, hostname),
      };
      res.status(201).json(body);
    },
  );

  router.post('/:domainId/verify', guard('deployment:control'), async (req, res: Response) => {
    const { project } = requireProjectAccess(req);

    const body: CustomDomainResponse = {
      domain: await options.domains.verify(project.id, idFrom(req)),
    };
    res.status(200).json(body);
  });

  router.delete('/:domainId', guard('deployment:control'), async (req, res: Response) => {
    const { project } = requireProjectAccess(req);
    await options.domains.remove(project.id, idFrom(req));
    res.status(204).end();
  });

  return router;
}

function idFrom(req: Request): string {
  const raw = req.params.domainId;
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new AppError('NOT_FOUND', 'There is no domain with that identifier');
  }
  return raw;
}

export function certificateAuthorizationRoutes(options: { domains: DomainService }): Router {
  const router = Router();

  router.get('/', async (req: Request, res: Response) => {
    const domain = req.query.domain;

    if (typeof domain !== 'string' || domain.length === 0) {
      res.status(400).end();
      return;
    }

    const allowed = await options.domains.mayIssueCertificate(domain);

    res.status(allowed ? 200 : 404).end();
  });

  return router;
}
