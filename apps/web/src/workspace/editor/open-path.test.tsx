import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useOpenFiles, type OpenFilesState } from './use-open-files.js';

const PROJECT = '018f0000-0000-7000-8000-0000000000aa';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const entry = (path: string) => ({
  path,
  name: path.split('/').pop()!,
  type: 'FILE',
  size: 10,
  isBinary: false,
  version: 1,
  updatedAt: '2026-01-01T00:00:00.000Z',
});

let state: OpenFilesState;

function Harness(): React.JSX.Element {
  state = useOpenFiles(PROJECT, true);
  return (
    <ul>
      {state.files.map((file) => (
        <li key={file.path} data-status={file.status}>
          {file.name}: {file.content}
        </li>
      ))}
    </ul>
  );
}

function mockReads(
  respond: (path: string) => Response = (path) =>
    json({ entry: entry(path), content: 'from server', encoding: 'utf8' }),
) {
  const reads: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      const path = url.searchParams.get('path') ?? '';
      if ((init?.method ?? 'GET') === 'GET') reads.push(path);
      return Promise.resolve(respond(path));
    }),
  );
  return reads;
}

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe('openPath', () => {
  it('opens a nested file by its path and makes it active', async () => {
    mockReads();
    render(<Harness />);

    act(() => state.openPath('src/index.js'));

    expect(await screen.findByText('index.js: from server')).toBeInTheDocument();
    expect(state.activePath).toBe('src/index.js');
  });

  it('does not reload an open file, so unsaved typing survives a second open', async () => {
    const reads = mockReads();
    render(<Harness />);
    act(() => state.openPath('a.js'));
    await screen.findByText('a.js: from server');

    act(() => state.change('a.js', 'typed here'));
    act(() => state.openPath('a.js'));

    expect(screen.getByText('a.js: typed here')).toBeInTheDocument();
    expect(reads.filter((path) => path === 'a.js')).toHaveLength(1);
  });

  it('brings an already open file forward without a second tab', async () => {
    mockReads();
    render(<Harness />);
    act(() => state.openPath('a.js'));
    act(() => state.openPath('b.js'));
    await screen.findByText('b.js: from server');

    act(() => state.openPath('a.js'));

    expect(state.activePath).toBe('a.js');
    expect(state.files.map((file) => file.path)).toEqual(['a.js', 'b.js']);
  });

  it('tries again when the file failed to open the first time', async () => {
    let fail = true;
    mockReads((path) =>
      fail
        ? json({ error: { code: 'INTERNAL', message: 'Broken' } }, 500)
        : json({ entry: entry(path), content: 'second try', encoding: 'utf8' }),
    );
    render(<Harness />);
    act(() => state.openPath('a.js'));
    await waitFor(() => expect(state.files[0]?.status).toBe('error'));

    fail = false;
    act(() => state.openPath('a.js'));

    expect(await screen.findByText('a.js: second try')).toBeInTheDocument();
  });
});
