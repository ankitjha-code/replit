/**
 * Error taxonomy shared by the API and the web client.
 *
 * Every failure that crosses the HTTP or WebSocket boundary is reduced to one
 * of these codes so the frontend can react to a stable contract instead of
 * parsing prose. The mapping to HTTP status lives in the API error handler.
 */
export const ERROR_CODES = [
  'BAD_REQUEST',
  'VALIDATION_FAILED',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'RATE_LIMITED',
  'PAYLOAD_TOO_LARGE',
  'PRECONDITION_FAILED',
  'RUNTIME_UNAVAILABLE',
  'EXECUTION_FAILED',
  'STORAGE_FAILED',
  'INTERNAL_ERROR',
  'SERVICE_UNAVAILABLE',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** Wire shape of every non-2xx API response body. */
export interface ApiErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    /** Field-level detail for VALIDATION_FAILED; omitted otherwise. */
    details?: unknown;
    /** Correlates the response with server logs. */
    requestId: string;
  };
}
