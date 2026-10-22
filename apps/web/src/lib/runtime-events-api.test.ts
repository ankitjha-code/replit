import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchRuntimeEvents } from './runtime-events-api.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

const respond = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('fetchRuntimeEvents', () => {
  it('reads the history and returns the events', async () => {
    const spy = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(
        respond({
          events: [
            { id: 'e1', from: null, to: 'CREATING', reason: null, at: '2026-09-30T00:00:00Z' },
          ],
        }),
      ),
    );
    vi.stubGlobal('fetch', spy);
    const events = await fetchRuntimeEvents('p 1');
    expect(events).toHaveLength(1);
    expect(events[0]?.to).toBe('CREATING');
    expect(String(spy.mock.calls[0]?.[0])).toBe('/api/projects/p%201/runtime/events');
  });

  it('rejects a payload that is not a history', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(respond({ events: [{ id: 1 }] }))),
    );
    await expect(fetchRuntimeEvents('p1')).rejects.toThrow();
  });
});
