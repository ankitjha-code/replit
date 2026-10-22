import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../../errors/app-error.js';

export interface RateLimitStore {
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

  private sweep(now: number): void {
    if (now - this.lastSweep < 60_000) return;
    this.lastSweep = now;
    for (const [key, window] of this.windows) {
      if (window.resetAt <= now) this.windows.delete(key);
    }
  }

  clear(): void {
    this.windows.clear();
  }
}

export interface RateLimitOptions {
  windowMs: number;
  max: number;
  store: RateLimitStore;
  bucket: string;
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

function clientAddress(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}
