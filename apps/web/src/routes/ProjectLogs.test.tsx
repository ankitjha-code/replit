import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectEvent } from '@platform/shared';
import { ProjectLogs } from './ProjectLogs.js';

/**
 * The retained log. The assertions are about honesty under volume: filters
 * that stay applied while paging, a tail that fetches only what is new, and a
 * window that renders a few dozen rows out of twenty thousand.
 */

const PROJECT = '018f0000-0000-7000-8000-0000000000aa';

/** The project socket, replaced so a test can deliver an event by hand. */
let deliver: ((event: ProjectEvent) => void) | undefined;
vi.mock('../workspace/use-project-events.js', () => ({
  useProjectEvents: (_projectId: string, onEvent: (event: ProjectEvent) => void) => {
    deliver = onEvent;
    return { members: [], others: [], connected: true, setFile: () => undefined };
  },
}));

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const line = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: `l${n}`,
  source: 'RUN',
  sourceId: 'rt-1',
  stream: 'stdout',
  message: `line ${n}`,
  at: new Date(Date.UTC(2026, 0, 1, 0, 0, n % 60)).toISOString(),
  ...overrides,
});

const page = (lines: unknown[], overrides: Record<string, unknown> = {}) => ({
  lines,
  olderCursor: null,
  retainedLines: 20_000,
  truncated: false,
  ...overrides,
});

/** Answers every read with `respond(url)` and records the query strings asked for. */
function mockApi(respond: (url: URL) => unknown) {
  const queries: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost');
      queries.push(url.search);
      const body = respond(url);
      return Promise.resolve(body instanceof Response ? body : json(body));
    }),
  );
  return queries;
}

const renderLogs = () =>
  render(
    <MemoryRouter>
      <ProjectLogs projectId={PROJECT} />
    </MemoryRouter>,
  );

const viewer = () => screen.getByRole('region', { name: 'Application output' });

/** The scroller's offset, remembered per element because jsdom lays nothing out. */
const scrollTops = new WeakMap<HTMLElement, number>();

beforeEach(() => {
  // jsdom lays nothing out; give the scroller a height so the window has rows,
  // and a scroll offset that fires `scroll` when set, as a browser's does.
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get() {
      return (this as HTMLElement).classList.contains('logs-viewer') ? 400 : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
    configurable: true,
    get() {
      return scrollTops.get(this as HTMLElement) ?? 0;
    },
    set(value: number) {
      scrollTops.set(this as HTMLElement, value);
      (this as HTMLElement).dispatchEvent(new Event('scroll'));
    },
  });
});

afterEach(() => {
  deliver = undefined;
  vi.unstubAllGlobals();
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    value: 0,
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
    configurable: true,
    writable: true,
    value: 0,
  });
});

describe('logs', () => {
  it('renders a window of rows out of twenty thousand, with the zone stated once', async () => {
    const many = Array.from({ length: 20_000 }, (_, n) => line(n));
    mockApi(() => page(many));
    renderLogs();

    await screen.findByText(/20,000 lines shown/);
    const rows = viewer().querySelectorAll('.log-line');
    expect(rows.length).toBeGreaterThan(10);
    expect(rows.length).toBeLessThan(100);
    expect(screen.getByText(/^Times in /)).toBeInTheDocument();
  });

  it('still shows rows when a filter shrinks the list under a deep scroll offset', async () => {
    const many = Array.from({ length: 20_000 }, (_, n) => line(n));
    const few = Array.from({ length: 500 }, (_, n) => line(n, { stream: 'stderr' }));
    mockApi((url) => page(url.searchParams.has('stream') ? few : many));
    renderLogs();

    await screen.findByText(/20,000 lines shown/);
    // Scrolled far into the long list, as after reading for a while.
    act(() => {
      viewer().scrollTop = 29_600;
    });
    expect(screen.queryByText('line 19999')).toBeNull();
    expect(viewer().querySelectorAll('.log-line').length).toBeGreaterThan(0);

    await userEvent.selectOptions(screen.getByLabelText('Which stream'), 'stderr');
    await screen.findByText(/500 lines shown/);
    expect(viewer().querySelectorAll('.log-line').length).toBeGreaterThan(0);
  });

  it('marks stderr, keeps the program colours and drops the escape bytes', async () => {
    mockApi(() =>
      page([
        line(1, { stream: 'stderr', message: 'boom' }),
        line(2, { message: '\u001b[32mok\u001b[0m done' }),
      ]),
    );
    renderLogs();

    const error = await screen.findByText('boom');
    expect(error.closest('.log-line')?.className).toContain('stderr');
    const ok = screen.getByText('ok');
    expect(ok).toHaveClass('ansi-fg-green');
    expect(viewer().textContent).not.toContain('\u001b');
  });

  it('keeps the filter when loading older output', async () => {
    const queries = mockApi((url) =>
      url.searchParams.has('before')
        ? page([line(1, { message: 'older error' })], { olderCursor: null })
        : page([line(2, { message: 'newer error' })], { olderCursor: 'l2' }),
    );
    renderLogs();

    await userEvent.selectOptions(await screen.findByLabelText('Which stream'), 'stderr');
    const search = screen.getByLabelText('Find in output');
    await userEvent.type(search, 'error{Enter}');
    expect(await screen.findByText(/Applied:/)).toHaveTextContent('error');

    await userEvent.click(screen.getByRole('button', { name: 'Load older' }));
    expect(await screen.findByText('older error')).toBeInTheDocument();

    const older = queries.find((query) => query.includes('before='));
    expect(older).toContain('stream=stderr');
    expect(older).toContain('contains=error');
    expect(older).toContain('before=l2');
  });

  it('offers one runtime or deployment once it has seen it, and narrows by sourceId', async () => {
    const queries = mockApi(() =>
      page([line(1), line(2, { source: 'DEPLOYMENT', sourceId: 'dep-42' })]),
    );
    renderLogs();

    const where = await screen.findByLabelText('Where from');
    const option = await within(where).findByRole('option', { name: /Deployment dep-42/ });
    await userEvent.selectOptions(where, option);

    await waitFor(() => expect(queries.at(-1)).toContain('sourceId=dep-42'));
    expect(screen.getByRole('link', { name: 'Download' })).toHaveAttribute(
      'href',
      expect.stringContaining('sourceId=dep-42'),
    );
  });

  it('fetches only what is new when following and the app prints more', async () => {
    const queries = mockApi((url) =>
      url.searchParams.has('after') ? page([line(3)]) : page([line(1), line(2)]),
    );
    renderLogs();

    await screen.findByText('line 2');
    await userEvent.click(screen.getByRole('switch', { name: 'Follow' }));
    act(() => deliver?.({ type: 'logs.appended' } as ProjectEvent));

    expect(await screen.findByText('line 3')).toBeInTheDocument();
    expect(queries.at(-1)).toContain('after=l2');
    expect(screen.getByText(/3 lines shown/)).toBeInTheDocument();
  });

  it('ignores appended events while not following', async () => {
    const queries = mockApi(() => page([line(1)]));
    renderLogs();

    await screen.findByText('line 1');
    const before = queries.length;
    act(() => deliver?.({ type: 'logs.appended' } as ProjectEvent));
    expect(queries.length).toBe(before);
  });

  it('shows the empty state with a way to the workspace, and a clear when filters hide everything', async () => {
    mockApi((url) => (url.searchParams.has('contains') ? page([]) : page([line(1)])));
    renderLogs();

    await screen.findByText('line 1');
    await userEvent.type(screen.getByLabelText('Find in output'), 'nothing{Enter}');
    expect(await screen.findByText('Nothing matches these filters.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(await screen.findByText('line 1')).toBeInTheDocument();
  });

  it('says when nothing has been kept yet', async () => {
    mockApi(() => page([]));
    renderLogs();

    expect(await screen.findByText('No output kept yet.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open workspace' })).toHaveAttribute(
      'href',
      `/projects/${PROJECT}`,
    );
  });

  it('shows the error with a retry when the log cannot be read', async () => {
    let attempts = 0;
    mockApi(() => {
      attempts += 1;
      return attempts === 1
        ? json({ error: { code: 'INTERNAL', message: 'The log store is unavailable.' } }, 500)
        : page([line(1)]);
    });
    renderLogs();

    expect(await screen.findByRole('alert')).toHaveTextContent('The log store is unavailable.');
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('line 1')).toBeInTheDocument();
  });
});
