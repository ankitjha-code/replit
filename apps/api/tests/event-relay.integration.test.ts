import Redis from 'ioredis';
import { afterAll, describe, expect, it } from 'vitest';
import type { ProjectEvent } from '@platform/shared';
import { ProjectEventBus } from '../src/events/project-event-bus.js';
import { RedisEventRelay } from '../src/events/redis-event-relay.js';
import { silentLogger } from './setup/app.js';

/**
 * Two control-plane instances, as two buses sharing one Redis.
 *
 * Requires the Redis profile: `docker compose --profile queue up -d redis`.
 */

const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6389';

const redisUp = await (async () => {
  const probe = new Redis(REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 0,
    connectTimeout: 1_000,
  });
  try {
    await probe.connect();
    await probe.quit();
    return true;
  } catch {
    probe.disconnect();
    return false;
  }
})();

const relays: RedisEventRelay[] = [];

afterAll(async () => {
  for (const relay of relays) await relay.close();
});

function instance() {
  const bus = new ProjectEventBus(silentLogger());
  const relay = new RedisEventRelay(REDIS_URL, bus, silentLogger());
  bus.useRelay(relay);
  relays.push(relay);
  return bus;
}

function received(bus: ProjectEventBus, projectId: string): ProjectEvent[] {
  const seen: ProjectEvent[] = [];
  bus.subscribe(projectId, (event) => seen.push(event));
  return seen;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

describe.skipIf(!redisUp)('events across control-plane instances', () => {
  it('reaches a browser connected to the other instance', async () => {
    const a = instance();
    const b = instance();
    await settle();

    const onB = received(b, 'p-1');
    a.publish('p-1', { type: 'jobs.changed' });
    await settle();

    expect(onB).toEqual([{ type: 'jobs.changed' }]);
  });

  it('is delivered once on the instance that published it, not echoed back', async () => {
    const a = instance();
    instance();
    await settle();

    const onA = received(a, 'p-2');
    a.publish('p-2', { type: 'jobs.changed' });
    await settle();

    expect(onA).toHaveLength(1);
  });

  it('drops anything on the channel that is not a real event', async () => {
    const b = instance();
    await settle();
    const onB = received(b, 'p-3');

    const outsider = new Redis(REDIS_URL);
    await outsider.publish(
      'platform:project-events',
      JSON.stringify({ from: 'someone', projectId: 'p-3', event: { type: 'not.an.event' } }),
    );
    await outsider.publish('platform:project-events', 'not even json');
    await outsider.quit();
    await settle();

    expect(onB).toEqual([]);
  });
});
