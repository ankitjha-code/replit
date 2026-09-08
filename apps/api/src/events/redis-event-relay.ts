import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import type { Logger } from 'pino';
import { projectEventSchema, type ProjectEvent } from '@platform/shared';
import type { ProjectEventBus } from './project-event-bus.js';

/**
 * Carries project events between control-plane processes, through Redis.
 *
 * ## What it carries, and what it does not
 *
 * **Events** — a file changed, a runtime moved, a deployment finished, new log
 * lines. With two API instances behind a load balancer, a person connected to
 * one would otherwise never see a change made through the other, which is the
 * kind of bug that looks like the product being unreliable rather than like a
 * missing feature.
 *
 * **Not presence**, and **not the shared documents themselves.** Presence is
 * derived from the sockets a process holds, and two people editing one file
 * through two instances would be two separate CRDT documents in two processes'
 * memory. Both need sticky routing — one project's sockets to one instance —
 * which is a load-balancer setting, and the architecture document says so. This
 * relay makes everything *else* correct across instances.
 *
 * ## Why not trust the channel
 *
 * Anything that can reach Redis can publish on it. Incoming messages are parsed
 * against the same schema the browser uses, and anything that does not parse is
 * dropped: an event causes a page to re-fetch, and a malformed one should cause
 * nothing at all.
 */

const CHANNEL = 'platform:project-events';

export class RedisEventRelay {
  /** So this process ignores its own messages when they come back round. */
  private readonly instanceId = randomUUID();
  private readonly publisher: Redis;
  private readonly subscriber: Redis;

  constructor(
    url: string,
    private readonly bus: ProjectEventBus,
    private readonly log: Logger,
  ) {
    // Two connections, because a Redis connection in subscribe mode can do
    // nothing else.
    const options = { lazyConnect: false, maxRetriesPerRequest: 1, enableOfflineQueue: false };
    this.publisher = new Redis(url, options);
    this.subscriber = new Redis(url, options);

    for (const client of [this.publisher, this.subscriber]) {
      // Redis being down must not take the control plane down with it: events
      // still reach this process's own listeners, and other instances catch up
      // the next time their pages re-fetch.
      client.on('error', (error: unknown) => {
        this.log.warn({ err: error }, 'the event relay cannot reach Redis');
      });
    }

    /*
     * Subscribed on every `ready`, not once.
     *
     * The offline queue is off, so nothing piles up in memory while Redis is
     * unreachable — which also means a subscribe sent before the connection is
     * up is simply refused. Subscribing each time the connection becomes ready
     * covers the first connection and every reconnection after an outage.
     */
    this.subscriber.on('ready', () => {
      void this.subscriber.subscribe(CHANNEL).catch((error: unknown) => {
        this.log.warn({ err: error }, 'the event relay could not subscribe');
      });
    });

    this.subscriber.on('message', (_channel: string, raw: string) => this.receive(raw));
  }

  send(projectId: string, event: ProjectEvent): void {
    const message = JSON.stringify({ from: this.instanceId, projectId, event });
    void this.publisher.publish(CHANNEL, message).catch(() => {
      // Logged by the connection's error handler; one lost event costs a
      // re-fetch that happens anyway on the next change.
    });
  }

  private receive(raw: string): void {
    let parsed: { from?: unknown; projectId?: unknown; event?: unknown };
    try {
      parsed = JSON.parse(raw) as typeof parsed;
    } catch {
      return;
    }

    if (parsed.from === this.instanceId) return;
    if (typeof parsed.projectId !== 'string' || parsed.projectId.length > 64) return;

    const event = projectEventSchema.safeParse(parsed.event);
    if (!event.success) return;

    this.bus.deliverLocally(parsed.projectId, event.data);
  }

  async close(): Promise<void> {
    await Promise.allSettled([this.subscriber.quit(), this.publisher.quit()]);
  }
}
