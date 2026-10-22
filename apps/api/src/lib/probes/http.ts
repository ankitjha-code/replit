import { request as httpRequest } from 'node:http';
import type { DependencyProbe } from '../../modules/health/health.service.js';

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
        response.resume();
        finish(true);
      },
    );

    request.on('timeout', () => finish(false));
    request.on('error', () => finish(false));
    request.end();
  });
}

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
