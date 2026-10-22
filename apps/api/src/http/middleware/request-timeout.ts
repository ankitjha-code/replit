import type { NextFunction, Request, Response } from 'express';
import type { Logger } from 'pino';

/**
 * A ceiling on how long an ordinary request may take.
 *
 * The server's own request timeout is disabled, deliberately and for a good
 * reason: this process holds WebSocket upgrades and streams output, and a
 * connection-level timeout would cut a terminal off mid-session. That leaves
 * every ordinary request with no ceiling at all, which is the gap this closes.
 *
 * An unbounded request is a held connection, a held database connection behind
 * it, and a person watching a spinner. Enough of them is an outage caused by
 * something being slow rather than by anything being broken.
 *
 * ## What it does not do
 *
 * It does not cancel the work. Nothing here can: the handler is somewhere down
 * a promise chain with its own database query, and Node has no way to reach in
 * and stop it. What ends is the platform's willingness to keep the connection
 * open, and that is said plainly rather than dressed up — a timed-out request
 * may still be writing to the database a second later.
 *
 * The one thing it must never do is respond twice, so a response that has
 * already started is left alone entirely.
 */
export function requestTimeout(options: { timeoutMs: number; log: Logger }) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const timer = setTimeout(() => {
      /*
       * Streaming responses are exempt by having already started.
       *
       * An asset download, a snapshot archive and a build log are all responses
       * whose size depends on what somebody stored, and the time they take is
       * not evidence of anything being wrong. Once headers are out, this steps
       * back.
       */
      if (res.headersSent) return;

      options.log.warn(
        { method: req.method, path: req.path, timeoutMs: options.timeoutMs },
        'a request took longer than this platform allows',
      );

      res.status(504).json({
        error: {
          code: 'SERVICE_UNAVAILABLE',
          // Says what happened and what it means, without implying the work was
          // undone: it may well still be happening.
          message:
            'This took longer than the platform allows and was given up on. It may still have happened; check before trying again.',
          requestId: req.requestId,
        },
      });
    }, options.timeoutMs);

    // Cleared on every ending, including the client disconnecting, so a timer
    // is never left behind holding a reference to a finished request.
    res.on('finish', () => clearTimeout(timer));
    res.on('close', () => clearTimeout(timer));

    next();
  };
}
