import type { Env } from '../../config/env.js';
import { httpProbe } from '../../lib/probes/http.js';
import { hostPortFromUrl, tcpProbe } from '../../lib/probes/tcp.js';
import type { HealthService } from './health.service.js';

/**
 * Registers a probe for each piece of infrastructure that is actually
 * configured.
 *
 * An unconfigured dependency is not registered at all, rather than registered
 * and reported as down. Readiness then answers a precise question: is
 * everything this deployment is wired to working? A service nobody is running
 * is not a failure.
 */
export function registerInfrastructureProbes(
  health: HealthService,
  config: Env,
  hasDatabaseClient = false,
): void {
  // The database is probed with a real query when a client is connected; see
  // databaseProbe. A TCP probe is registered only when the URL is configured
  // but no client was built, which happens in narrow diagnostic setups.
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
    /*
     * A TCP probe rather than an SMTP greeting.
     *
     * The mail provider's own `unavailableReason` does the greeting, and does it
     * where the answer is acted on. Health checks run constantly, and opening a
     * real submission session on every one of them is the kind of traffic that
     * gets an installation rate-limited by its own mail relay.
     */
    health.register(tcpProbe('mail', config.SMTP_HOST, config.SMTP_PORT));
  }

  if (config.STORAGE_ENDPOINT) {
    // MinIO answers this path when the object layer is initialised, which is
    // stronger evidence than the port merely being open.
    const url = new URL('/minio/health/live', config.STORAGE_ENDPOINT);
    health.register(httpProbe('storage', url.toString()));
  }
}
