import type { JobQueue } from './queue.js';

/**
 * The queue an installation gets when there is no Redis.
 *
 * Unlike the other "unavailable" implementations in this codebase, this one is
 * not a refusal. It genuinely works: a nudge reaches every worker in this
 * process, which on a single-host installation is every worker there is.
 *
 * What it does not do is cross a process boundary. A worker started as its own
 * process alongside the API will never hear a nudge from it, and will pick the
 * same work up on its next poll instead. That is a latency difference and not a
 * correctness one, because the database decides what is claimable — but it is
 * worth knowing before deciding an installation does not need Redis.
 */
export class InMemoryJobQueue implements JobQueue {
  readonly name = 'memory';

  private readonly listeners = new Set<() => void>();

  /**
   * Never unavailable.
   *
   * There is nothing to be unreachable: the nudge is a function call.
   */
  unavailableReason(): Promise<string | null> {
    return Promise.resolve(null);
  }

  publish(): void {
    // A copy, because a listener may unsubscribe itself while being called and
    // mutating the set underneath the iteration would skip its neighbour.
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        /*
         * Swallowed on purpose.
         *
         * A nudge is advice. A listener that throws while being told there is
         * work must not be able to fail the thing that recorded the work, which
         * has already happened by the time this runs.
         */
      }
    }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): Promise<void> {
    this.listeners.clear();
    return Promise.resolve();
  }
}
