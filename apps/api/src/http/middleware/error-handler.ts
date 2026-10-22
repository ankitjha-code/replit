import type { NextFunction, Request, Response } from 'express';
import type { ApiErrorBody } from '@platform/shared';
import { AppError } from '../../errors/app-error.js';
import { normalizeError } from '../../errors/normalize.js';
import { childLogger } from '../../lib/logger.js';

/** Terminal 404 for unmatched routes, so it flows through the error handler. */
export function notFoundHandler() {
  return (req: Request, _res: Response, next: NextFunction): void => {
    next(new AppError('NOT_FOUND', `No route for ${req.method} ${req.path}`));
  };
}

/**
 * The single place an error becomes an HTTP response.
 *
 * Server-side failures are logged in full and answered with a generic message,
 * so internal detail never reaches the client.
 */
export function errorHandler() {
  return (err: unknown, req: Request, res: Response, next: NextFunction): void => {
    if (res.headersSent) {
      next(err);
      return;
    }

    const appError = normalizeError(err);

    const log = childLogger({ requestId: req.requestId, path: req.path, method: req.method });
    const payload = {
      code: appError.code,
      status: appError.status,
      ...(appError.context ?? {}),
    };

    if (appError.status >= 500) {
      log.error({ ...payload, err: appError }, appError.message);
    } else {
      log.warn(payload, appError.message);
    }

    const body: ApiErrorBody = {
      error: {
        code: appError.code,
        message: appError.expose ? appError.message : 'An unexpected error occurred',
        requestId: req.requestId,
        ...(appError.expose && appError.details !== undefined ? { details: appError.details } : {}),
      },
    };

    res.status(appError.status).json(body);
  };
}
