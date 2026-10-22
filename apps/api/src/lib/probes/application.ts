import { request as httpRequest } from 'node:http';

/**
 * Asking a project's own application whether it is answering.
 *
 * Separate from the port probe beside it, which asks a different question. That
 * one asks "is anything listening here", accepts any answer including an error,
 * and exists so the preview can find a port. This one asks "is the application
 * healthy", which means the status matters.
 *
 * What it does **not** do is as important. It reads no body, follows no
 * redirect, and sends no cookie. The thing being probed is code the platform
 * did not write, running on somebody's behalf: it is a black box that gets one
 * request and gives back a number.
 */

export interface ApplicationProbeResult {
  /** The status the application answered with, or null when nothing did. */
  statusCode: number | null;
  latencyMs: number;
  /** Why nothing answered, when nothing did. Safe to show. */
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
        /*
         * A fixed Host header, not the platform's.
         *
         * The application is reached on a loopback address the container
         * runtime published, which is not a name it knows itself by. Sending
         * the platform's own hostname would tell somebody else's code a name it
         * has no business learning, and sending none makes some frameworks
         * refuse the request outright.
         */
        headers: { host: 'healthcheck' },
      },
      (response) => {
        /*
         * The body is discarded without being read.
         *
         * Only the status is evidence, and a body could be any size at all:
         * reading one would let a project make the platform's health check hold
         * a gigabyte in memory.
         */
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
        // Deliberately not the driver's message, which carries an address and a
        // port that mean nothing to the person reading this.
        statusCode: null,
        message: 'The application could not be reached.',
      }),
    );

    request.end();
  });
}
