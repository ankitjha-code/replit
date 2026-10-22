import Redis from 'ioredis';
import type { Logger } from 'pino';
import type { JobQueue } from './queue.js';

export interface RedisQueueOptions {
  url: string;
  channel: string;
}

export class RedisJobQueue implements JobQueue {
  readonly name = 'redis';

  private readonly publisher: Redis;
  private readonly subscriber: Redis;
  private readonly listeners = new Set<() => void>();

  private failure: string | null = 'Not connected yet.';
  private closed = false;

  constructor(
    private readonly options: RedisQueueOptions,
    private readonly log: Logger,
  ) {
    this.publisher = this.connect('publisher');
    this.subscriber = this.connect('subscriber');

    void this.subscriber
      .subscribe(this.options.channel)
      .then(() => {
        this.failure = null;
      })
      .catch((error: unknown) => {
        this.failure = 'The queue channel could not be subscribed to.';
        this.log.warn({ err: error }, 'could not subscribe to the job channel');
      });

    this.subscriber.on('message', (channel) => {
      if (channel !== this.options.channel) return;
      this.fan();
    });
  }

  unavailableReason(): Promise<string | null> {
    return Promise.resolve(this.failure);
  }

  publish(): void {
    if (this.closed) return;

    void this.publisher.publish(this.options.channel, '1').catch((error: unknown) => {
      this.log.debug({ err: error }, 'a job nudge could not be published');
    });

    this.fan();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.listeners.clear();

    await Promise.allSettled([this.publisher.quit(), this.subscriber.quit()]);
  }

  private connect(role: string): Redis {
    const client = new Redis(this.options.url, {
      lazyConnect: false,
      retryStrategy: (attempt) => Math.min(attempt * 200, 5_000),
      maxRetriesPerRequest: 1,
    });

    client.on('error', (error: Error) => {
      this.failure = 'The queue is not reachable, so workers pick work up on their next poll.';
      this.log.debug({ err: error, role }, 'the job queue connection failed');
    });

    client.on('ready', () => {
      this.failure = null;
    });

    return client;
  }

  private fan(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {}
    }
  }
}
