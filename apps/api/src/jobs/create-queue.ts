import type { Logger } from 'pino';
import type { Env } from '../config/env.js';
import { InMemoryJobQueue } from './memory-queue.js';
import type { JobQueue } from './queue.js';
import { RedisJobQueue } from './redis-queue.js';

export function createJobQueue(config: Env, log: Logger): JobQueue {
  if (!config.REDIS_URL) return new InMemoryJobQueue();

  return new RedisJobQueue({ url: config.REDIS_URL, channel: config.REDIS_JOB_CHANNEL }, log);
}
