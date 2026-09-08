import { request as httpRequest } from 'node:http';
import type { DependencyProbe } from '../../modules/health/health.service.js';

/**
 * Whether something answers an HTTP request on a port.
 *
 * Used to find which of a workload's ports an application is on, and
 * deliberately not a TCP connect. A container runtime publishes a port by
 * binding it on the host itself, and that binding accepts connections whether
 * or not anything inside is listening. A connect therefore succeeds against an
 * empty container, and a preview built on that evidence would show a browser
 * error page and blame the platform.
 *
 * Any answer counts, including an error status. The question is whether
 * something is there, not whether it is happy.
 */
export function isServingHttp(host: string, port: number, timeoutMs = 1_000): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (serving: boolean): void => {
      if (settled) return;
      settled = true;
      request.destroy();
      resolve(serving);
    };

    const request = httpRequest(
      { host, port, method: 'GET', path: '/', timeout: timeoutMs, headers: { host: 'preview' } },
      (response) => {
        // The body is never read. Only that headers arrived is evidence, and
        // the body could be any size.
        response.resume();
        finish(true);
      },
    );

    request.on('timeout', () => finish(false));
    request.on('error', () => finish(false));
    request.end();
  });
}

/**
 * Probes a service's own health endpoint over HTTP.
 *
 * Stronger evidence than a TCP connect, because the service answered as
 * itself. The response body is discarded: only the status is evidence, and
 * an upstream body could contain anything.
 */
export function httpProbe(name: string, url: string, timeoutMs = 1_500): DependencyProbe {
  return {
    name,
    check: async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await fetch(url, { method: 'GET', signal: controller.signal });
        return response.ok
          ? { status: 'up' as const, detail: `http ${response.status}` }
          : { status: 'down' as const, detail: `http ${response.status}` };
      } catch (error) {
        const aborted = error instanceof Error && error.name === 'AbortError';
        return {
          status: 'down' as const,
          detail: aborted ? `timed out after ${timeoutMs}ms` : 'request failed',
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
