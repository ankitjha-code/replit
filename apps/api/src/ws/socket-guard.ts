import type { Logger } from 'pino';

export interface SocketGuardOptions {
  maxPerUser: number;
  maxAttempts: number;
  attemptWindowMs: number;
  log: Logger;
}

export type SocketRefusal =
  | { ok: false; status: 429; reason: 'too-many-sockets' }
  | { ok: false; status: 429; reason: 'too-many-attempts' };

export type SocketDecision = { ok: true; release: () => void } | SocketRefusal;

export class SocketGuard {
  private readonly held = new Map<string, number>();

  private readonly attempts = new Map<string, { count: number; resetAt: number }>();

  private lastSweep = Date.now();

  constructor(private readonly options: SocketGuardOptions) {}

  mayAttempt(address: string): boolean {
    const now = Date.now();
    this.sweep(now);

    const window = this.attempts.get(address);

    if (!window || window.resetAt <= now) {
      this.attempts.set(address, { count: 1, resetAt: now + this.options.attemptWindowMs });
      return true;
    }

    window.count += 1;

    if (window.count > this.options.maxAttempts) {
      this.options.log.warn(
        { address, attempts: window.count },
        'socket upgrades are being refused',
      );
      return false;
    }

    return true;
  }

  acquire(userId: string): SocketDecision {
    const held = this.held.get(userId) ?? 0;

    if (held >= this.options.maxPerUser) {
      this.options.log.info(
        { userId, held },
        'an account is holding as many sockets as it may at once',
      );
      return { ok: false, status: 429, reason: 'too-many-sockets' };
    }

    this.held.set(userId, held + 1);

    let released = false;

    return {
      ok: true,
      release: () => {
        if (released) return;
        released = true;

        const remaining = (this.held.get(userId) ?? 1) - 1;
        if (remaining <= 0) this.held.delete(userId);
        else this.held.set(userId, remaining);
      },
    };
  }

  heldBy(userId: string): number {
    return this.held.get(userId) ?? 0;
  }

  total(): number {
    let sum = 0;
    for (const count of this.held.values()) sum += count;
    return sum;
  }

  private sweep(now: number): void {
    if (now - this.lastSweep < 60_000) return;
    this.lastSweep = now;

    for (const [key, window] of this.attempts) {
      if (window.resetAt <= now) this.attempts.delete(key);
    }
  }
}

export class MessageBudget {
  private tokens: number;
  private lastRefill = Date.now();

  constructor(
    private readonly capacity: number,
    private readonly perSecond: number,
  ) {
    this.tokens = capacity;
  }

  take(): boolean {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;

    if (elapsed > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.perSecond);
      this.lastRefill = now;
    }

    if (this.tokens < 1) return false;

    this.tokens -= 1;
    return true;
  }
}
