import type { ApiErrorBody, ErrorCode } from '@platform/shared';

/**
 * The single path from the browser to the control plane.
 *
 * Every non-2xx response is normalised into `ApiError`, so callers branch on a
 * stable code rather than sniffing status numbers or message text.
 */
export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly requestId: string | undefined;
  readonly details: unknown;
  /** From a `Retry-After` header on a 429 or 503, when the server sent one. */
  readonly retryAfterSeconds: number | undefined;

  constructor(
    code: ErrorCode,
    message: string,
    status: number,
    requestId?: string,
    details?: unknown,
    retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.requestId = requestId;
    this.details = details;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
  headers?: Record<string, string>;
  /** Lets a request outlive its page, for a save flushed on unmount. */
  keepalive?: boolean;
}

/** Same-origin by default: the dev server and the reverse proxy both front the API. */
const BASE_URL = import.meta.env.VITE_API_BASE_URL ?? '';

type UnauthorizedHandler = (error: ApiError, path: string) => void;
const unauthorizedHandlers = new Set<UnauthorizedHandler>();

/**
 * Called whenever the server answers 401. The auth provider uses it to notice
 * a session that ended underneath an open page. Returns the unsubscribe.
 */
export function onUnauthorized(handler: UnauthorizedHandler): () => void {
  unauthorizedHandlers.add(handler);
  return () => {
    unauthorizedHandlers.delete(handler);
  };
}

let reachable = true;
const connectivityListeners = new Set<() => void>();

function setReachable(next: boolean): void {
  if (next === reachable) return;
  reachable = next;
  for (const listener of connectivityListeners) listener();
}

/**
 * Whether the last request got an answer from the server at all. A response
 * of any status counts as reachable; only a failed connection does not. Read
 * with `useSyncExternalStore` by the connection banner.
 */
export const connectivity = {
  isReachable: (): boolean => reachable,
  subscribe(listener: () => void): () => void {
    connectivityListeners.add(listener);
    return () => {
      connectivityListeners.delete(listener);
    };
  },
};

/** Seconds from a `Retry-After` header, which may be a delay or an HTTP date. */
export function parseRetryAfter(
  header: string | null,
  now: number = Date.now(),
): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, Math.ceil((at - now) / 1000));
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, signal, headers = {}, keepalive } = options;

  let response: Response;
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      method,
      // Sessions ride on a cookie, so credentials must be included.
      credentials: 'include',
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(signal ? { signal } : {}),
      ...(keepalive ? { keepalive: true } : {}),
    });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
    setReachable(false);
    throw new ApiError('SERVICE_UNAVAILABLE', 'Could not reach the server', 0);
  }

  setReachable(true);

  if (response.status === 204) return undefined as T;

  const payload: unknown = await response.json().catch(() => undefined);

  if (!response.ok) {
    const envelope = payload as ApiErrorBody | undefined;
    const error = new ApiError(
      envelope?.error?.code ?? 'INTERNAL_ERROR',
      envelope?.error?.message ?? `Request failed with status ${response.status}`,
      response.status,
      envelope?.error?.requestId,
      envelope?.error?.details,
      parseRetryAfter(response.headers.get('retry-after')),
    );
    if (response.status === 401) {
      for (const handler of unauthorizedHandlers) handler(error, path);
    }
    throw error;
  }

  return payload as T;
}
