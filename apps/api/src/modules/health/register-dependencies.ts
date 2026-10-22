import type { Env } from '../../config/env.js';
import { httpProbe } from '../../lib/probes/http.js';
import { hostPortFromUrl, tcpProbe } from '../../lib/probes/tcp.js';
import type { HealthService } from './health.service.js';

export function registerInfrastructureProbes(
  health: HealthService,
  config: Env,
  hasDatabaseClient = false,
): void {
  if (config.DATABASE_URL && !hasDatabaseClient) {
    const target = hostPortFromUrl(config.DATABASE_URL, 5432);
    if (target) {
      health.register(tcpProbe('postgres', target.host, target.port));
    }
  }

  if (config.REDIS_URL) {
    const target = hostPortFromUrl(config.REDIS_URL, 6379);
    if (target) {
      health.register(tcpProbe('redis', target.host, target.port));
    }
  }

  if (config.SMTP_HOST) {
    health.register(tcpProbe('mail', config.SMTP_HOST, config.SMTP_PORT));
  }

  if (config.STORAGE_ENDPOINT) {
    const url = new URL('/minio/health/live', config.STORAGE_ENDPOINT);
    health.register(httpProbe('storage', url.toString()));
  }
}
