import type { JobQueue } from './queue.js';

export class InMemoryJobQueue implements JobQueue {
  readonly name = 'memory';

  private readonly listeners = new Set<() => void>();

  unavailableReason(): Promise<string | null> {
    return Promise.resolve(null);
  }

  publish(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {}
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
