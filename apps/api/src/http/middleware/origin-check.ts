import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../../errors/app-error.js';

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
          context: { origin },
        }),
      );
      return;
    }

    next();
  };
}
