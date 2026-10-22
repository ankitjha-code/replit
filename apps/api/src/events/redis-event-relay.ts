import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import type { Logger } from 'pino';
import { projectEventSchema, type ProjectEvent } from '@platform/shared';
import type { ProjectEventBus } from './project-event-bus.js';

const CHANNEL = 'platform:project-events';

export class RedisEventRelay {
  private readonly instanceId = randomUUID();
  private readonly publisher: Redis;
  private readonly subscriber: Redis;

  constructor(
    url: string,
    private readonly bus: ProjectEventBus,
    private readonly log: Logger,
  ) {
    const options = { lazyConnect: false, maxRetriesPerRequest: 1, enableOfflineQueue: false };
    this.publisher = new Redis(url, options);
    this.subscriber = new Redis(url, options);

    for (const client of [this.publisher, this.subscriber]) {
      client.on('error', (error: unknown) => {
        this.log.warn({ err: error }, 'the event relay cannot reach Redis');
      });
    }

    this.subscriber.on('ready', () => {
      void this.subscriber.subscribe(CHANNEL).catch((error: unknown) => {
        this.log.warn({ err: error }, 'the event relay could not subscribe');
      });
    });

    this.subscriber.on('message', (_channel: string, raw: string) => this.receive(raw));
  }

  send(projectId: string, event: ProjectEvent): void {
    const message = JSON.stringify({ from: this.instanceId, projectId, event });
    void this.publisher.publish(CHANNEL, message).catch(() => {});
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
