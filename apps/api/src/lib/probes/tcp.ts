import net from 'node:net';
import type { DependencyProbe } from '../../modules/health/health.service.js';

/**
 * Reachability probe: opens a TCP connection and closes it.
 *
 * This measures exactly one thing, that something is accepting connections on
 * the port, and its reported detail says so. It is deliberately not described
 * as a database health check: a probe that claims more than it measured is the
 * same lie as a fabricated metric.
 *
 * Replaced by a real query probe once a client for the service exists.
 */
export function tcpProbe(
  name: string,
  host: string,
  port: number,
  timeoutMs = 1_500,
): DependencyProbe {
  return {
    name,
    check: () =>
      new Promise((resolve) => {
        const socket = new net.Socket();
        let settled = false;

        const finish = (status: 'up' | 'down', detail: string): void => {
          if (settled) return;
          settled = true;
          socket.destroy();
          resolve({ status, detail });
        };

        socket.setTimeout(timeoutMs);
        socket.once('connect', () => finish('up', `tcp ${host}:${port} accepting connections`));
        socket.once('timeout', () => finish('down', `tcp ${host}:${port} timed out`));
        socket.once('error', (error: NodeJS.ErrnoException) =>
          finish('down', `tcp ${host}:${port} ${error.code ?? error.message}`),
        );

        socket.connect(port, host);
      }),
  };
}

/**
 * Extracts a host and port from a connection URL.
 *
 * The URL itself is never returned or logged, because it carries credentials.
 */
export function hostPortFromUrl(
  url: string,
  defaultPort: number,
): { host: string; port: number } | undefined {
  try {
    const parsed = new URL(url);
    if (!parsed.hostname) return undefined;
    const port = parsed.port === '' ? defaultPort : Number(parsed.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined;
    return { host: parsed.hostname, port };
  } catch {
    return undefined;
  }
}
