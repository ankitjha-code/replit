import { request as httpRequest } from 'node:http';

export interface ApplicationProbeResult {
  statusCode: number | null;
  latencyMs: number;
  message: string | null;
}

export function probeApplication(options: {
  host: string;
  port: number;
  path: string;
  timeoutMs: number;
}): Promise<ApplicationProbeResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    let settled = false;

    const finish = (result: Omit<ApplicationProbeResult, 'latencyMs'>): void => {
      if (settled) return;
      settled = true;
      request.destroy();
      resolve({ ...result, latencyMs: Date.now() - started });
    };

    const request = httpRequest(
      {
        host: options.host,
        port: options.port,
        method: 'GET',
        path: options.path,
        timeout: options.timeoutMs,
        headers: { host: 'healthcheck' },
      },
      (response) => {
        response.resume();
        finish({ statusCode: response.statusCode ?? null, message: null });
      },
    );

    request.on('timeout', () =>
      finish({
        statusCode: null,
        message: `Nothing answered within ${String(options.timeoutMs)}ms.`,
      }),
    );

    request.on('error', () =>
      finish({
        statusCode: null,
        message: 'The application could not be reached.',
      }),
    );

    request.end();
  });
}
