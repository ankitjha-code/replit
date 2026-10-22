import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../../errors/app-error.js';

/**
 * Cross-site request forgery defence for cookie-authenticated requests.
 *
 * The session cookie is `SameSite=Lax`, which already withholds it from
 * cross-site subresource requests and cross-site form posts. This is the
 * second layer, and it exists because SameSite is a browser behaviour: an old
 * browser, or one where it is relaxed, would leave the platform open with no
 * server-side check at all.
 *
 * The rule is narrow on purpose. Only unsafe methods are checked, because a
 * GET must never change state anyway. A request with no Origin header is
 * allowed through, since non-browser clients (curl, a CI script, a test) do not
 * send one and forbidding them would break every integration for no gain: the
 * attack this stops requires a browser, and browsers do send it.
 */

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function checkOrigin(allowedOrigins: readonly string[]) {
  const allowed = new Set(allowedOrigins);

  return (req: Request, _res: Response, next: NextFunction): void => {
    if (SAFE_METHODS.has(req.method)) {
      next();
      return;
    }

    const origin = req.get('origin');
    if (!origin) {
      next();
      return;
    }

    if (!allowed.has(origin)) {
      next(
        new AppError('FORBIDDEN', 'Request origin is not allowed', {
          // Logged for diagnosis, never returned: echoing it back would help
          // an attacker work out what the allowlist contains.
          context: { origin },
        }),
      );
      return;
    }

    next();
  };
}
