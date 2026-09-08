import { AppError, isAppError } from './app-error.js';
import type { ErrorCode } from '@platform/shared';

/**
 * Express middleware (body parsers, CORS, multipart) throw plain `Error`
 * objects that carry a `status`/`statusCode` and a machine-readable `type`.
 * Without translation those collapse into a generic 500, which would tell a
 * client "server broke" when the truth is "your request was too big".
 */
interface HttpishError {
  status?: unknown;
  statusCode?: unknown;
  type?: unknown;
  expose?: unknown;
  message?: unknown;
}

const CODE_BY_STATUS: Readonly<Record<number, ErrorCode>> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  412: 'PRECONDITION_FAILED',
  413: 'PAYLOAD_TOO_LARGE',
  422: 'VALIDATION_FAILED',
  429: 'RATE_LIMITED',
  503: 'SERVICE_UNAVAILABLE',
};

function readStatus(error: HttpishError): number | undefined {
  for (const value of [error.status, error.statusCode]) {
    if (typeof value === 'number' && value >= 400 && value <= 599) return value;
  }
  return undefined;
}

/** Reduce any thrown value to the one error type the HTTP layer renders. */
export function normalizeError(error: unknown): AppError {
  if (isAppError(error)) return error;

  if (typeof error === 'object' && error !== null) {
    const candidate = error as HttpishError;
    const status = readStatus(candidate);

    if (status !== undefined) {
      const code = CODE_BY_STATUS[status] ?? (status >= 500 ? 'INTERNAL_ERROR' : 'BAD_REQUEST');
      const message =
        typeof candidate.message === 'string' && candidate.message.length > 0
          ? candidate.message
          : 'Request failed';

      return new AppError(code, message, {
        status,
        // `expose` follows the http-errors convention: 4xx is safe to show.
        expose: typeof candidate.expose === 'boolean' ? candidate.expose : status < 500,
        cause: error,
        ...(typeof candidate.type === 'string' ? { context: { type: candidate.type } } : {}),
      });
    }
  }

  return new AppError('INTERNAL_ERROR', 'An unexpected error occurred', { cause: error });
}
