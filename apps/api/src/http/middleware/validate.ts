import type { NextFunction, Request, Response } from 'express';
import type { ZodType } from 'zod';
import { AppError } from '../../errors/app-error.js';

/**
 * Validates a request body against a schema before any handler sees it.
 *
 * The parsed value replaces the raw body, so handlers receive exactly the
 * declared shape: unknown fields are gone, strings are trimmed, and types are
 * whatever the schema produced. A handler cannot accidentally read a field the
 * client invented.
 */
export function validateBody<T>(schema: ZodType<T>) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body);

    if (!result.success) {
      next(
        new AppError('VALIDATION_FAILED', 'The submitted values are not valid', {
          // Field-level detail is safe and necessary: it is derived from what
          // the client just sent, and without it a form cannot show the user
          // which input to fix.
          details: {
            fields: result.error.issues.map((issue) => ({
              path: issue.path.map(String).join('.') || '(root)',
              message: issue.message,
            })),
          },
        }),
      );
      return;
    }

    req.body = result.data;
    next();
  };
}
