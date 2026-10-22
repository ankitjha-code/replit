import net from 'node:net';
import type { DependencyProbe } from '../../modules/health/health.service.js';

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
