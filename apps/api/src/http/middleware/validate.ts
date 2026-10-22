import type { NextFunction, Request, Response } from 'express';
import type { ZodType } from 'zod';
import { AppError } from '../../errors/app-error.js';

export function validateBody<T>(schema: ZodType<T>) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body);

    if (!result.success) {
      next(
        new AppError('VALIDATION_FAILED', 'The submitted values are not valid', {
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
