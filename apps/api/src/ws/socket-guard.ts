import type { Logger } from 'pino';

/**
 * Limits that apply to every socket, across every gateway.
 *
 * The per-project ceilings each gateway already has answer "how many terminals
 * may one project have". They cannot answer the two questions that matter most
 * for the platform as a whole:
 *
 *  - **How many sockets may one account hold?** A person with twenty projects
 *    is under every per-project limit while holding eighty connections, and a
 *    person who creates projects in a loop is under them for ever.
 *  - **How fast may one client try to connect?** Nothing bounded upgrade
 *    attempts at all. A client whose reconnect loop has gone wrong — or one
 *    deliberately storming — makes the control plane resolve a session and
 *    authorize a project on every attempt, which is two database queries per
 *    attempt with no ceiling.
 *
 * Both are cheap to check and neither can be checked in one gateway, because
 * the point of both is that they span all four.
 *
 * ## Counted here, decided at the upgrade
 *
 * This holds counters and nothing else. A gateway asks before accepting and
 * releases when a socket closes, which keeps the decision where the refusal has
 * to be made — before a socket exists — and keeps this file free of anything
 * that knows what a WebSocket is.
 */

export interface SocketGuardOptions {
  /** Sockets one account may hold at once, across every gateway. */
  maxPerUser: number;
  /** Upgrade attempts one client may make in a window, refused or not. */
  maxAttempts: number;
  attemptWindowMs: number;
  log: Logger;
}

export type SocketRefusal =
  /** The account already holds as many sockets as it may. */
  | { ok: false; status: 429; reason: 'too-many-sockets' }
  /** The client is trying to connect faster than it may. */
  | { ok: false; status: 429; reason: 'too-many-attempts' };

export type SocketDecision = { ok: true; release: () => void } | SocketRefusal;

export class SocketGuard {
  /** Open sockets per account, across every gateway. */
  private readonly held = new Map<string, number>();

  /** Recent upgrade attempts, per key, with the window they belong to. */
  private readonly attempts = new Map<string, { count: number; resetAt: number }>();

  private lastSweep = Date.now();

  constructor(private readonly options: SocketGuardOptions) {}

  /**
   * Whether a client may try to open a socket at all.
   *
   * Asked **before** the session is resolved and the project authorized, which
   * is the only place it is worth asking: the cost this bounds is those two
   * queries, and checking afterwards would mean paying them in order to decide
   * not to pay them.
   *
   * Keyed by address for that reason — there is no account yet. A shared address
   * therefore shares a budget, which is why the number is generous: it is there
   * to stop a runaway loop, not to ration connections.
   */
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

  /**
   * Takes a slot for an account, or refuses.
   *
   * Asked after the upgrade has been authorized, because until then there is no
   * account to charge it to. Returns the release rather than an identifier: a
   * caller that has to remember a key in order to give a slot back is a caller
   * that will eventually forget, and a leaked slot is a person who cannot open
   * a terminal again until the process restarts.
   */
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
        // Idempotent, because a socket ends in more than one way: a close, an
        // error, and a gateway shutting down can all arrive for the same one.
        if (released) return;
        released = true;

        const remaining = (this.held.get(userId) ?? 1) - 1;
        if (remaining <= 0) this.held.delete(userId);
        else this.held.set(userId, remaining);
      },
    };
  }

  /** How many sockets one account is holding. Diagnostics only. */
  heldBy(userId: string): number {
    return this.held.get(userId) ?? 0;
  }

  /** Every socket held on this process, across every account, for the metrics page. */
  total(): number {
    let sum = 0;
    for (const count of this.held.values()) sum += count;
    return sum;
  }

  /**
   * Drops expired attempt windows.
   *
   * Without it the map grows once per distinct address and never shrinks, which
   * is a slow leak an attacker can drive — the same reason the HTTP rate-limit
   * store sweeps.
   */
  private sweep(now: number): void {
    if (now - this.lastSweep < 60_000) return;
    this.lastSweep = now;

    for (const [key, window] of this.attempts) {
      if (window.resetAt <= now) this.attempts.delete(key);
    }
  }
}

/**
 * How fast a client may send on a socket it already holds.
 *
 * Separate from everything above, and per socket rather than per account,
 * because it bounds a different thing: not how many connections exist but how
 * much work one of them can ask for. The terminal and document sockets both
 * accept client messages, and both hand what arrives to something that does
 * real work — a pseudo-terminal, a CRDT.
 *
 * A token bucket rather than a fixed window, because the traffic is bursty by
 * nature: a paste into a terminal is a hundred messages in a moment and is
 * entirely legitimate, while a hundred a second sustained is not.
 */
export class MessageBudget {
  private tokens: number;
  private lastRefill = Date.now();

  constructor(
    /** The most that may arrive in a burst. */
    private readonly capacity: number,
    /** How many are restored per second once the burst is spent. */
    private readonly perSecond: number,
  ) {
    this.tokens = capacity;
  }

  /**
   * Whether one more message may be acted on.
   *
   * False means drop it, not close the socket. A client that oversteps is far
   * more often a paste or a loop than an attack, and cutting somebody's terminal
   * off for typing quickly would be a worse failure than the one being
   * prevented.
   */
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
