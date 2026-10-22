import Redis from 'ioredis';
import type { Logger } from 'pino';
import type { JobQueue } from './queue.js';

/**
 * Nudges that cross a process boundary.
 *
 * Redis publish/subscribe, and nothing else: no list, no stream, no consumer
 * group. That is the point rather than a simplification. The jobs are rows in
 * the platform's database, which is what makes them durable, claimable exactly
 * once, and visible to anybody asking what is outstanding. Putting them in Redis
 * as well would create a second answer to that question, and it would be the one
 * that empties when Redis restarts.
 *
 * So what Redis provides here is latency. Without it a worker in another process
 * finds work on its next poll, a second or two later; with it, immediately. An
 * installation can lose Redis entirely and keep working more slowly, which is
 * exactly the failure mode worth having.
 *
 * Two connections, because a subscribed client may not issue other commands.
 * That is Redis's rule, not a choice made here.
 */

export interface RedisQueueOptions {
  url: string;
  /** The channel nudges are published on. Namespaced so a shared Redis is safe. */
  channel: string;
}

export class RedisJobQueue implements JobQueue {
  readonly name = 'redis';

  private readonly publisher: Redis;
  private readonly subscriber: Redis;
  private readonly listeners = new Set<() => void>();

  /** The last connection error, for the health probe to report. */
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

  /**
   * Says there is work, and does not wait to find out whether anybody heard.
   *
   * Deliberately not awaited by the caller and deliberately swallowing its own
   * failure. This runs after the work has already been recorded; a nudge that
   * could fail an enqueue would let the optional part break the essential one.
   */
  publish(): void {
    if (this.closed) return;

    void this.publisher.publish(this.options.channel, '1').catch((error: unknown) => {
      this.log.debug({ err: error }, 'a job nudge could not be published');
    });

    /*
     * Told locally as well as remotely.
     *
     * Redis does not deliver a message back to the connection that published it
     * in the way this needs, and a worker in the same process as the enqueue is
     * the commonest arrangement. Without this it would be the only one that has
     * to wait for a poll.
     */
    this.fan();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.listeners.clear();

    // `quit` rather than `disconnect`, so an in-flight publish is allowed to
    // finish rather than being cut off mid-command.
    await Promise.allSettled([this.publisher.quit(), this.subscriber.quit()]);
  }

  private connect(role: string): Redis {
    const client = new Redis(this.options.url, {
      lazyConnect: false,
      /*
       * Retries for ever, with a bounded delay.
       *
       * Giving up would turn a Redis restart into a platform that never nudges
       * again until somebody notices. Nothing depends on the connection being
       * up, so retrying quietly is free.
       */
      retryStrategy: (attempt) => Math.min(attempt * 200, 5_000),
      maxRetriesPerRequest: 1,
    });

    client.on('error', (error: Error) => {
      this.failure = 'The queue is not reachable, so workers pick work up on their next poll.';
      // Debug rather than error: an unreachable queue is a slower platform, not
      // a broken one, and logging every reconnection attempt at error level
      // would bury things that matter.
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
      } catch {
        // A nudge is advice. A listener that throws must not be able to affect
        // anything else.
      }
    }
  }
}
