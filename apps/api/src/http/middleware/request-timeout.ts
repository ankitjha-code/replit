import type { NextFunction, Request, Response } from 'express';
import type { Logger } from 'pino';

export function requestTimeout(options: { timeoutMs: number; log: Logger }) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const timer = setTimeout(() => {
      if (res.headersSent) return;

      options.log.warn(
        { method: req.method, path: req.path, timeoutMs: options.timeoutMs },
        'a request took longer than this platform allows',
      );

      res.status(504).json({
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message:
            'This took longer than the platform allows and was given up on. It may still have happened; check before trying again.',
          requestId: req.requestId,
        },
      });
    }, options.timeoutMs);

    res.on('finish', () => clearTimeout(timer));
    res.on('close', () => clearTimeout(timer));

    next();
  };
}
