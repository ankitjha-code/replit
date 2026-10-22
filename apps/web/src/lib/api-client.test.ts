import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  apiRequest,
  connectivity,
  onUnauthorized,
  parseRetryAfter,
} from './api-client.js';

const mockFetch = (impl: typeof fetch) => {
  vi.stubGlobal('fetch', vi.fn(impl));
};

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const fetchSpy = () => {
  const spy = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
    Promise.resolve(jsonResponse({})),
  );
  vi.stubGlobal('fetch', spy);
  return spy;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('apiRequest', () => {
  it('returns the parsed body on success', async () => {
    mockFetch(() => Promise.resolve(jsonResponse({ ok: true })));
    await expect(apiRequest<{ ok: boolean }>('/health/live')).resolves.toEqual({ ok: true });
  });

  it('sends credentials so the session cookie travels', async () => {
    const spy = fetchSpy();
    await apiRequest('/health/live');
    expect(spy.mock.calls[0]?.[1]).toMatchObject({ credentials: 'include' });
  });

  it('normalises the server error envelope', async () => {
    mockFetch(() =>
      Promise.resolve(
        jsonResponse({ error: { code: 'FORBIDDEN', message: 'Nope', requestId: 'req-1' } }, 403),
      ),
    );
    const error = await apiRequest('/projects/1').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('FORBIDDEN');
    expect((error as ApiError).requestId).toBe('req-1');
  });

  it('falls back to INTERNAL_ERROR when the body is not an envelope', async () => {
    mockFetch(() => Promise.resolve(new Response('gateway blew up', { status: 502 })));
    const error = (await apiRequest('/x').catch((e: unknown) => e)) as ApiError;
    expect(error.code).toBe('INTERNAL_ERROR');
    expect(error.status).toBe(502);
  });

  it('reports an unreachable server rather than throwing a network error', async () => {
    mockFetch(() => Promise.reject(new TypeError('Failed to fetch')));
    const error = (await apiRequest('/x').catch((e: unknown) => e)) as ApiError;
    expect(error.code).toBe('SERVICE_UNAVAILABLE');
    expect(error.status).toBe(0);
  });

  it('resolves undefined for a 204', async () => {
    mockFetch(() => Promise.resolve(new Response(null, { status: 204 })));
    await expect(apiRequest('/x', { method: 'DELETE' })).resolves.toBeUndefined();
  });

  it('serialises a JSON body and sets the content type', async () => {
    const spy = fetchSpy();
    await apiRequest('/projects', { method: 'POST', body: { name: 'demo' } });
    const init = spy.mock.calls[0]?.[1];
    expect(init?.body).toBe('{"name":"demo"}');
    expect((init?.headers as Record<string, string>)['content-type']).toBe('application/json');
  });

  it('passes keepalive through, so a save can outlive its page', async () => {
    const spy = fetchSpy();
    await apiRequest('/files', { method: 'PUT', body: {}, keepalive: true });
    expect(spy.mock.calls[0]?.[1]).toMatchObject({ keepalive: true });
    await apiRequest('/files');
    expect(spy.mock.calls[1]?.[1]).not.toHaveProperty('keepalive');
  });

  it('reads Retry-After into the error', async () => {
    mockFetch(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ error: { code: 'RATE_LIMITED', message: 'Too many', requestId: 'r' } }),
          { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '120' } },
        ),
      ),
    );
    const error = (await apiRequest('/x').catch((e: unknown) => e)) as ApiError;
    expect(error.retryAfterSeconds).toBe(120);
  });

  it('leaves retryAfterSeconds undefined without the header', async () => {
    mockFetch(() => Promise.resolve(new Response('nope', { status: 502 })));
    const error = (await apiRequest('/x').catch((e: unknown) => e)) as ApiError;
    expect(error.retryAfterSeconds).toBeUndefined();
  });

  it('tells subscribers about a 401 until they unsubscribe', async () => {
    mockFetch(() =>
      Promise.resolve(
        jsonResponse(
          { error: { code: 'UNAUTHENTICATED', message: 'Sign in', requestId: 'r' } },
          401,
        ),
      ),
    );
    const handler = vi.fn();
    const stop = onUnauthorized(handler);
    await apiRequest('/api/projects').catch(() => undefined);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]?.[0]).toBeInstanceOf(ApiError);
    expect(handler.mock.calls[0]?.[1]).toBe('/api/projects');

    stop();
    await apiRequest('/api/projects').catch(() => undefined);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('does not report other failures as unauthorised', async () => {
    mockFetch(() => Promise.resolve(new Response('nope', { status: 403 })));
    const handler = vi.fn();
    const stop = onUnauthorized(handler);
    await apiRequest('/x').catch(() => undefined);
    stop();
    expect(handler).not.toHaveBeenCalled();
  });

  it('tracks whether the server can be reached at all', async () => {
    const listener = vi.fn();
    const stop = connectivity.subscribe(listener);

    mockFetch(() => Promise.reject(new TypeError('Failed to fetch')));
    await apiRequest('/x').catch(() => undefined);
    expect(connectivity.isReachable()).toBe(false);
    expect(listener).toHaveBeenCalledTimes(1);

    mockFetch(() => Promise.resolve(new Response('nope', { status: 500 })));
    await apiRequest('/x').catch(() => undefined);
    expect(connectivity.isReachable()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(2);
    stop();
  });
});

describe('parseRetryAfter', () => {
  it('accepts a delay in seconds', () => {
    expect(parseRetryAfter('90')).toBe(90);
  });

  it('accepts an HTTP date, rounded up to whole seconds', () => {
    const now = Date.parse('2026-01-01T00:00:00.000Z');
    expect(parseRetryAfter('Thu, 01 Jan 2026 00:02:00 GMT', now)).toBe(120);
  });

  it('never returns a negative wait or a value for nonsense', () => {
    const now = Date.parse('2026-01-01T00:10:00.000Z');
    expect(parseRetryAfter('Thu, 01 Jan 2026 00:00:00 GMT', now)).toBe(0);
    expect(parseRetryAfter('soon')).toBeUndefined();
    expect(parseRetryAfter(null)).toBeUndefined();
  });
});
