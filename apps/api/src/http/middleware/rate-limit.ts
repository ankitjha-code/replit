import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../../errors/app-error.js';

/**
 * Request rate limiting.
 *
 * Registration and login are the endpoints an attacker hits hardest: the first
 * to enumerate which addresses have accounts, the second to guess passwords.
 * Both also do expensive key-derivation work, so an unlimited request rate is
 * a denial-of-service vector against the platform itself.
 *
 * The store is an interface because this implementation is per-process. That
 * is honest and sufficient for a single control plane; the day there is more
 * than one, a shared store replaces it without touching call sites.
 */

export interface RateLimitStore {
  /** Records a hit and returns the running count and when the window ends. */
  hit(key: string, windowMs: number): { count: number; resetAt: number };
}

export class MemoryRateLimitStore implements RateLimitStore {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();
  private lastSweep = Date.now();

  hit(key: string, windowMs: number): { count: number; resetAt: number } {
    const now = Date.now();
    this.sweep(now);

    const existing = this.windows.get(key);
    if (existing && existing.resetAt > now) {
      existing.count += 1;
      return existing;
    }

    const fresh = { count: 1, resetAt: now + windowMs };
    this.windows.set(key, fresh);
    return fresh;
  }

  /**
   * Drops expired entries periodically. Without this the map grows once per
   * distinct client address and never shrinks, which is a slow memory leak an
   * attacker can drive.
   */
  private sweep(now: number): void {
    if (now - this.lastSweep < 60_000) return;
    this.lastSweep = now;
    for (const [key, window] of this.windows) {
      if (window.resetAt <= now) this.windows.delete(key);
    }
  }

  /** Test-only. */
  clear(): void {
    this.windows.clear();
  }
}

export interface RateLimitOptions {
  windowMs: number;
  max: number;
  store: RateLimitStore;
  /** Distinguishes limits that share a store. */
  bucket: string;
  /** Defaults to the client address. */
  keyOf?: (req: Request) => string;
}

export function rateLimit(options: RateLimitOptions) {
  const { windowMs, max, store, bucket, keyOf = clientAddress } = options;

  return (req: Request, res: Response, next: NextFunction): void => {
    const { count, resetAt } = store.hit(`${bucket}:${keyOf(req)}`, windowMs);
    const retryAfterSeconds = Math.max(1, Math.ceil((resetAt - Date.now()) / 1000));

    res.setHeader('RateLimit-Limit', max);
    res.setHeader('RateLimit-Remaining', Math.max(0, max - count));
    res.setHeader('RateLimit-Reset', retryAfterSeconds);

    if (count > max) {
      res.setHeader('Retry-After', retryAfterSeconds);
      next(
        new AppError('RATE_LIMITED', 'Too many requests. Try again shortly.', {
          context: { bucket, count },
        }),
      );
      return;
    }

    next();
  };
}

/**
 * The client's address.
 *
 * `req.ip` honours X-Forwarded-For only when the app is configured to trust a
 * proxy. Without that setting Express ignores the header, so a client cannot
 * escape its own limit by sending one.
 */
function clientAddress(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}
