import type { ApiErrorBody, ErrorCode } from '@platform/shared';

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly requestId: string | undefined;
  readonly details: unknown;
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
  keepalive?: boolean;
}

const BASE_URL = import.meta.env.VITE_API_BASE_URL ?? '';

type UnauthorizedHandler = (error: ApiError, path: string) => void;
const unauthorizedHandlers = new Set<UnauthorizedHandler>();

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

export const connectivity = {
  isReachable: (): boolean => reachable,
  subscribe(listener: () => void): () => void {
    connectivityListeners.add(listener);
    return () => {
      connectivityListeners.delete(listener);
    };
  },
};

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
