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

/**
 * Mounted under a project, so `:projectId` is already in the path.
 *
 * Reading needs `deployment:read`, which a viewer has: where a project is
 * published is part of being shown it. Everything that changes an address needs
 * `deployment:control`, which is an owner, because an address is what the
 * outside world knows a project by and changing one takes it away from
 * everybody who had the old one.
 */
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

  /**
   * Changes the label this project is published under.
   *
   * A PUT on its own path rather than a field of the deployment configuration:
   * it is not a build setting, and changing it changes an address people may
   * already have rather than changing what gets built next time.
   */
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

  /**
   * Checks whether the domain is really pointed here.
   *
   * A POST because it reaches outside the machine and writes down what it saw.
   * Asked for explicitly rather than on a timer, so somebody who has just edited
   * their DNS can find out now rather than waiting for a sweep.
   */
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

/** The domain a route names, or a not-found. */
function idFrom(req: Request): string {
  const raw = req.params.domainId;
  // Express types a route parameter as possibly repeated. A repeated one is not
  // a domain identifier.
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new AppError('NOT_FOUND', 'There is no domain with that identifier');
  }
  return raw;
}

/**
 * Whether the platform should hold a certificate for a hostname.
 *
 * Its own tiny router, mounted outside the authenticated API, because the thing
 * that asks is the reverse proxy rather than a person: it has no session and is
 * deciding, for an inbound TLS handshake, whether to go and obtain a
 * certificate. A proxy that issued for anything it was asked about would let one
 * request make this installation ask a certificate authority about a name it has
 * never heard of.
 *
 * It answers yes or no about a hostname and nothing else. That discloses whether
 * a name is served here, which anybody could learn by connecting to it anyway.
 *
 * It should still be reachable only from the proxy. That is a deployment
 * decision rather than a code one, and it is written down in the Caddyfile
 * beside the directive that calls this.
 */
export function certificateAuthorizationRoutes(options: { domains: DomainService }): Router {
  const router = Router();

  router.get('/', async (req: Request, res: Response) => {
    const domain = req.query.domain;

    if (typeof domain !== 'string' || domain.length === 0) {
      res.status(400).end();
      return;
    }

    const allowed = await options.domains.mayIssueCertificate(domain);

    /*
     * Status only, with no body.
     *
     * This is what the proxy reads, and it reads nothing else. A body would be
     * a payload nobody parses, on an endpoint whose one job is to be fast
     * enough to sit inside a TLS handshake.
     */
    res.status(allowed ? 200 : 404).end();
  });

  return router;
}
