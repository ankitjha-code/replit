import type { ErrorCode } from '@platform/shared';

/**
 * The only error type the HTTP layer knows how to render.
 *
 * `message` is safe to show a user. Anything sensitive belongs in `context`,
 * which is logged but never serialised into a response.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly expose: boolean;
  readonly details?: unknown;
  readonly context?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    options: {
      status?: number;
      expose?: boolean;
      details?: unknown;
      context?: Record<string, unknown>;
      cause?: unknown;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AppError';
    this.code = code;
    this.status = options.status ?? STATUS_BY_CODE[code];
    this.expose = options.expose ?? isSafeToExpose(this.status);
    if (options.details !== undefined) this.details = options.details;
    if (options.context !== undefined) this.context = options.context;
  }
}

/**
 * Whether a status's message may be shown to the caller.
 *
 * A 5xx message can carry internal detail, so it is replaced with a generic
 * one. 503 is the exception: "this is not available, because X" is the entire
 * message, it is what the caller needs in order to act, and it reveals nothing
 * they could not infer from the request failing. Without this carve-out an
 * unavailable dependency reports itself as an unexpected error, which sends
 * someone looking for a bug instead of at their configuration.
 */
function isSafeToExpose(status: number): boolean {
  return status < 500 || status === 503;
}

export const STATUS_BY_CODE: Readonly<Record<ErrorCode, number>> = {
  BAD_REQUEST: 400,
  VALIDATION_FAILED: 422,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  PAYLOAD_TOO_LARGE: 413,
  PRECONDITION_FAILED: 412,
  RUNTIME_UNAVAILABLE: 503,
  EXECUTION_FAILED: 500,
  STORAGE_FAILED: 500,
  INTERNAL_ERROR: 500,
  SERVICE_UNAVAILABLE: 503,
};

export const badRequest = (message: string, details?: unknown): AppError =>
  new AppError('BAD_REQUEST', message, details === undefined ? {} : { details });

export const notFound = (message = 'Resource not found'): AppError =>
  new AppError('NOT_FOUND', message);

export const unauthenticated = (message = 'Authentication required'): AppError =>
  new AppError('UNAUTHENTICATED', message);

export const forbidden = (message = 'You do not have access to this resource'): AppError =>
  new AppError('FORBIDDEN', message);

export const conflict = (message: string): AppError => new AppError('CONFLICT', message);

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}
