import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearToasts } from '../../ui/index.js';
import { entry, json, mockApi, renderPanel } from './test-helpers.js';

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  clearToasts();
});

const searches = (api: ReturnType<typeof mockApi>) =>
  api.calls.filter((call) => call.url.includes('/files/search'));

describe('searching files', () => {
  it('waits for two characters before asking the server', async () => {
    const api = mockApi([entry('index.js')]);
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText('index.js');

    await user.type(screen.getByRole('searchbox', { name: 'Search files' }), 'i');
    expect(await screen.findByText('Type at least 2 characters to search.')).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(searches(api)).toHaveLength(0);
  });

  it('sends one request for a burst of typing', async () => {
    const api = mockApi([entry('index.js')]);
    api.setSearch([{ path: 'index.js', match: 'path' }]);
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText('index.js');

    await user.type(screen.getByRole('searchbox', { name: 'Search files' }), 'index');
    const results = await screen.findByRole('list', { name: 'Search results' });

    expect(within(results).getByRole('button', { name: /index\.js/ })).toBeInTheDocument();
    expect(searches(api)).toHaveLength(1);
    expect(searches(api)[0]!.url).toContain('q=index');
  });

  it('shows where a content match is, and opens the file', async () => {
    const api = mockApi([entry('src', 'DIRECTORY'), entry('src/app.js')]);
    api.setSearch([{ path: 'src/app.js', match: 'content', line: 'listen(3000)', lineNumber: 12 }]);
    const user = userEvent.setup();
    const { onSelect } = renderPanel();
    await screen.findByText('src');

    await user.type(screen.getByRole('searchbox', { name: 'Search files' }), 'listen');
    const result = await screen.findByRole('button', { name: /app\.js/ });
    expect(result).toHaveTextContent('src/');
    expect(result).toHaveTextContent('12listen(3000)');

    await user.click(result);
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ path: 'src/app.js' }));
  });

  it('says when nothing matched', async () => {
    mockApi([entry('index.js')]);
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText('index.js');

    await user.type(screen.getByRole('searchbox', { name: 'Search files' }), 'zzz');
    expect(await screen.findByText('No matches for "zzz"')).toBeInTheDocument();
  });

  it('offers a retry when the search fails', async () => {
    const api = mockApi([entry('index.js')]);
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText('index.js');

    api.failNext(500, 'Search is unavailable');
    await user.type(screen.getByRole('searchbox', { name: 'Search files' }), 'ab');
    expect(await screen.findByRole('alert')).toHaveTextContent('Search is unavailable');

    api.setSearch([{ path: 'ab.js', match: 'path' }]);
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('button', { name: /ab\.js/ })).toBeInTheDocument();
  });

  it('clears on Escape, then goes back to the tree', async () => {
    mockApi([entry('index.js')]);
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText('index.js');

    const field = screen.getByRole('searchbox', { name: 'Search files' });
    await user.type(field, 'in');
    await user.keyboard('{Escape}');
    expect(field).toHaveValue('');
    expect(screen.getByRole('tree', { name: 'Project files' })).toBeInTheDocument();

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.getByRole('treeitem', { name: 'index.js' })).toHaveFocus());
  });

  it('abandons an older query when the text changes', async () => {
    mockApi([entry('index.js')]);
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText('index.js');

    const spy = globalThis.fetch as ReturnType<typeof vi.fn>;
    const original = spy.getMockImplementation()!;
    const aborted: string[] = [];
    spy.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/files/search')) {
        init?.signal?.addEventListener('abort', () => aborted.push(url));
        if (url.includes('q=ab') && !url.includes('q=abc')) {
          return new Promise<Response>(() => undefined);
        }
        return Promise.resolve(
          json({ results: [{ path: 'abc.js', match: 'path' }], truncated: false }),
        );
      }
      return original(input, init);
    });

    const field = screen.getByRole('searchbox', { name: 'Search files' });
    await user.type(field, 'ab');
    await new Promise((resolve) => setTimeout(resolve, 300));
    await user.type(field, 'c');

    expect(await screen.findByRole('button', { name: /abc\.js/ })).toBeInTheDocument();
    expect(aborted.some((url) => url.includes('q=ab') && !url.includes('q=abc'))).toBe(true);
  });
});
