import type { Logger } from 'pino';

export type BreakerState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerOptions {
  name: string;
  threshold: number;
  resetAfterMs: number;
  log: Logger;
  now?: () => number;
}

export class CircuitOpenError extends Error {
  constructor(readonly circuit: string) {
    super(`${circuit} is not responding, so the platform is not calling it right now.`);
    this.name = 'CircuitOpenError';
  }
}

export class CircuitBreaker {
  private failures = 0;
  private openedAt = 0;
  private state: BreakerState = 'closed';
  private probing = false;

  private readonly now: () => number;

  constructor(private readonly options: CircuitBreakerOptions) {
    this.now = options.now ?? (() => Date.now());
  }

  get status(): BreakerState {
    this.considerHalfOpen();
    return this.state;
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    this.considerHalfOpen();

    if (this.state === 'open') throw new CircuitOpenError(this.options.name);

    if (this.state === 'half-open') {
      if (this.probing) throw new CircuitOpenError(this.options.name);
      this.probing = true;
    }

    try {
      const result = await work();
      this.succeed();
      return result;
    } catch (error) {
      this.fail();
      throw error;
    } finally {
      this.probing = false;
    }
  }

  private succeed(): void {
    if (this.state !== 'closed') {
      this.options.log.info({ circuit: this.options.name }, 'a circuit closed again');
    }

    this.failures = 0;
    this.state = 'closed';
  }

  private fail(): void {
    this.failures += 1;

    if (this.state === 'half-open' || this.failures >= this.options.threshold) {
      if (this.state !== 'open') {
        this.options.log.error(
          { circuit: this.options.name, failures: this.failures },
          'a circuit opened: calls are being refused without being attempted',
        );
      }

      this.state = 'open';
      this.openedAt = this.now();
    }
  }

  private considerHalfOpen(): void {
    if (this.state !== 'open') return;
    if (this.now() - this.openedAt < this.options.resetAfterMs) return;

    this.state = 'half-open';
    this.probing = false;
  }
}
