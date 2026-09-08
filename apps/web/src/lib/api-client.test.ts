import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiRequest } from './api-client.js';

const mockFetch = (impl: typeof fetch) => {
  vi.stubGlobal('fetch', vi.fn(impl));
};

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A fetch double whose recorded arguments keep their real types. */
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
});
