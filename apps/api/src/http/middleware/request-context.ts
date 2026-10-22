import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Correlates this request with every log line it produces. */
      requestId: string;
    }
  }
}

const HEADER = 'x-request-id';
/** Accept an upstream id only if it is short and unremarkable. */
const SAFE_ID = /^[A-Za-z0-9._-]{1,64}$/;

export function requestContext() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const incoming = req.get(HEADER);
    req.requestId = incoming && SAFE_ID.test(incoming) ? incoming : randomUUID();
    res.setHeader(HEADER, req.requestId);
    next();
  };
}
