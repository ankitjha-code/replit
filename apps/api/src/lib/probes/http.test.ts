import { afterEach, describe, expect, it, vi } from 'vitest';
import { httpProbe } from './http.js';

afterEach(() => vi.unstubAllGlobals());

describe('httpProbe', () => {
  it('reports up on a 2xx', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('', { status: 200 }))),
    );
    const result = await httpProbe('storage', 'http://example.test/health').check();
    expect(result.status).toBe('up');
    expect(result.detail).toBe('http 200');
  });

  it('reports down on a 5xx', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('', { status: 503 }))),
    );
    expect((await httpProbe('storage', 'http://example.test/health').check()).status).toBe('down');
  });

  it('reports down when the request fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('connect ECONNREFUSED'))),
    );
    const result = await httpProbe('storage', 'http://example.test/health').check();
    expect(result.status).toBe('down');
    expect(result.detail).toBe('request failed');
  });

  it('does not echo the upstream body into the report', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('AWS_SECRET=leak', { status: 500 }))),
    );
    const result = await httpProbe('storage', 'http://example.test/health').check();
    expect(JSON.stringify(result)).not.toContain('leak');
  });

  it('times out rather than hanging', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
            });
          }),
      ),
    );
    const result = await httpProbe('storage', 'http://example.test/health', 20).check();
    expect(result.status).toBe('down');
    expect(result.detail).toContain('timed out');
  });
});
