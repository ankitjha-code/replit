import type { Logger } from 'pino';
import type { Env } from '../config/env.js';
import { InMemoryJobQueue } from './memory-queue.js';
import type { JobQueue } from './queue.js';
import { RedisJobQueue } from './redis-queue.js';

/**
 * Chooses how workers are told there is work.
 *
 * Unlike the other providers in this codebase, neither choice is a refusal. The
 * in-process one genuinely works — it is the right answer for a single-process
 * installation, and it is the default — and Redis buys exactly one thing: a
 * nudge that crosses a process boundary, so a worker running on its own reacts
 * immediately instead of on its next poll.
 *
 * Configured by whether a URL is present rather than by naming a provider. A
 * Redis is addressed by one URL, so having one is the whole decision, and an
 * installation that sets it has plainly asked for it.
 */
export function createJobQueue(config: Env, log: Logger): JobQueue {
  if (!config.REDIS_URL) return new InMemoryJobQueue();

  return new RedisJobQueue({ url: config.REDIS_URL, channel: config.REDIS_JOB_CHANNEL }, log);
}
