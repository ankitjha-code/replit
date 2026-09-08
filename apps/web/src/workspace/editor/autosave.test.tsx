import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileEntry } from '@platform/shared';
import { EditorPanel } from './EditorPanel.js';
import { useOpenFiles } from './use-open-files.js';

/**
 * Autosave timing and recovery.
 *
 * Kept apart from the panel suite because these cases drive a clock. Typing is
 * dispatched directly rather than through userEvent, which advances real time
 * and cannot be combined with a fake one.
 */

vi.mock('./CodeEditor.js', () => ({
  default: ({
    path,
    value,
    onChange,
  }: {
    path: string;
    value: string;
    revision: number;
    readOnly: boolean;
    onChange: (value: string) => void;
  }) => (
    <textarea
      aria-label={`Editing ${path}`}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}));

const PROJECT = '018f0000-0000-7000-8000-0000000000aa';

const entry = (path: string, overrides: Partial<FileEntry> = {}): FileEntry => ({
  path,
  name: path.split('/').pop()!,
  type: 'FILE',
  size: 10,
  isBinary: false,
  version: 1,
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Call {
  method: string;
  body: { content?: string; expectedVersion?: number } | undefined;
}

function mockApi(initial = 'start') {
  const calls: Call[] = [];
  let version = 1;
  let writeResult: (() => Response) | undefined;

  const spy = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ method, body: init?.body ? JSON.parse(String(init.body)) : undefined });

    if (method === 'PUT') {
      if (writeResult) return Promise.resolve(writeResult());
      version += 1;
      return Promise.resolve(json({ entry: entry('a.ts', { version }) }));
    }

    return Promise.resolve(
      json({ entry: entry('a.ts', { version }), content: initial, encoding: 'utf8' }),
    );
  });

  vi.stubGlobal('fetch', spy);
  return {
    calls,
    writes: () => calls.filter((call) => call.method === 'PUT'),
    fail: (result: () => Response) => {
      writeResult = result;
    },
    succeed: () => {
      writeResult = undefined;
    },
  };
}

function Harness(): React.JSX.Element {
  const files = useOpenFiles(PROJECT, true);
  return (
    <div>
      <button type="button" onClick={() => files.open(entry('a.ts'))}>
        open
      </button>
      <EditorPanel files={files} role="OWNER" projectId={PROJECT} />
    </div>
  );
}

/** Renders, opens the file, and waits for the editor. Real timers throughout. */
async function openFile(): Promise<HTMLTextAreaElement> {
  render(<Harness />);
  screen.getByRole('button', { name: 'open' }).click();
  return (await screen.findByLabelText('Editing a.ts')) as HTMLTextAreaElement;
}

/** Types by dispatching a change, which works under fake timers. */
function type(editor: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    'value',
  )!.set!;

  act(() => {
    setter.call(editor, value);
    editor.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** Advances the fake clock and lets any resulting promises settle. */
async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe('autosave timing', () => {
  it('saves shortly after typing stops', async () => {
    const api = mockApi();
    const editor = await openFile();
    vi.useFakeTimers();

    type(editor, 'start!');
    expect(api.writes()).toHaveLength(0);

    await advance(1_000);
    expect(api.writes()).toHaveLength(1);
    expect(api.writes()[0]?.body?.content).toBe('start!');
  });

  it('does not save on every keystroke', async () => {
    const api = mockApi();
    const editor = await openFile();
    vi.useFakeTimers();

    // Four changes inside the quiet period should cost one request, not four.
    for (const text of ['s', 'st', 'sta', 'star']) {
      type(editor, text);
      await advance(100);
    }

    expect(api.writes()).toHaveLength(0);
    await advance(1_000);
    expect(api.writes()).toHaveLength(1);
    expect(api.writes()[0]?.body?.content).toBe('star');
  });

  it('saves during continuous typing rather than waiting for a pause', async () => {
    // Without a ceiling, someone typing steadily for an hour has nothing
    // stored, and a crash loses all of it.
    const api = mockApi();
    const editor = await openFile();
    vi.useFakeTimers();

    for (let i = 0; i < 40; i += 1) {
      type(editor, `x`.repeat(i + 1));
      await advance(200);
    }

    expect(api.writes().length).toBeGreaterThan(0);
  });

  it('reports the buffer as unsaved between the keystroke and the save', async () => {
    mockApi();
    const editor = await openFile();
    vi.useFakeTimers();

    type(editor, 'start!');
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();

    await advance(1_000);
    expect(screen.getByText('Saved')).toBeInTheDocument();
  });

  it('saves an edit made while an earlier save was in flight', async () => {
    const api = mockApi();
    const editor = await openFile();
    vi.useFakeTimers();

    type(editor, 'first');
    await advance(1_000);
    type(editor, 'second');
    await advance(2_000);

    // The second edit must not be reported as saved by the first request.
    const writes = api.writes();
    expect(writes[writes.length - 1]?.body?.content).toBe('second');
  });

  it('sends the version it is replacing, so a concurrent write is detectable', async () => {
    const api = mockApi();
    const editor = await openFile();
    vi.useFakeTimers();

    type(editor, 'one');
    await advance(1_000);
    type(editor, 'two');
    await advance(1_000);

    const writes = api.writes();
    // The second write names the version the first produced.
    expect(writes[1]?.body?.expectedVersion).toBe(2);
  });

  it('does nothing when an edit is undone back to the saved text', async () => {
    const api = mockApi('start');
    const editor = await openFile();
    vi.useFakeTimers();

    type(editor, 'start!');
    await advance(200);
    type(editor, 'start');
    await advance(2_000);

    expect(api.writes()).toHaveLength(0);
    expect(screen.getByText('Saved')).toBeInTheDocument();
  });
});

describe('recovering from a failed save', () => {
  it('retries after a transient failure', async () => {
    const api = mockApi();
    const editor = await openFile();
    vi.useFakeTimers();

    api.fail(() =>
      json({ error: { code: 'INTERNAL_ERROR', message: 'boom', requestId: 'r' } }, 500),
    );

    type(editor, 'start!');
    await advance(1_000);
    expect(api.writes()).toHaveLength(1);
    expect(screen.getByText('Could not save. Retrying…')).toBeInTheDocument();

    await advance(2_000);
    expect(api.writes().length).toBeGreaterThan(1);
  });

  it('succeeds once the server recovers, without the text being touched', async () => {
    const api = mockApi();
    const editor = await openFile();
    vi.useFakeTimers();

    api.fail(() =>
      json({ error: { code: 'INTERNAL_ERROR', message: 'boom', requestId: 'r' } }, 500),
    );

    type(editor, 'start!');
    await advance(1_500);
    expect(screen.getByText('Could not save. Retrying…')).toBeInTheDocument();

    api.succeed();
    await advance(5_000);

    expect(screen.getByText('Saved')).toBeInTheDocument();
    expect(api.writes()[api.writes().length - 1]?.body?.content).toBe('start!');
    expect(editor).toHaveValue('start!');
  });

  it('backs off rather than hammering a failing server', async () => {
    const api = mockApi();
    const editor = await openFile();
    vi.useFakeTimers();

    api.fail(() =>
      json({ error: { code: 'INTERNAL_ERROR', message: 'boom', requestId: 'r' } }, 500),
    );

    type(editor, 'start!');
    await advance(30_000);

    // Exponential backoff over thirty seconds is a handful of attempts, not
    // one per timer tick.
    expect(api.writes().length).toBeLessThan(10);
    expect(api.writes().length).toBeGreaterThan(2);
  });

  it('stops retrying when the rejection cannot be fixed by trying again', async () => {
    const api = mockApi();
    const editor = await openFile();
    vi.useFakeTimers();

    api.fail(() =>
      json({ error: { code: 'FORBIDDEN', message: 'Not allowed', requestId: 'r' } }, 403),
    );

    type(editor, 'start!');
    await advance(1_000);
    const after = api.writes().length;

    await advance(60_000);
    expect(api.writes()).toHaveLength(after);
    expect(screen.getByText('Not saved')).toBeInTheDocument();
  });
});

describe('losing and regaining the network', () => {
  it('says the work will be saved when the connection returns', async () => {
    const api = mockApi();
    const editor = await openFile();
    vi.useFakeTimers();

    api.fail(() =>
      json({ error: { code: 'SERVICE_UNAVAILABLE', message: 'no', requestId: 'r' } }, 503),
    );
    act(() => {
      window.dispatchEvent(new Event('offline'));
    });

    type(editor, 'start!');
    await advance(1_000);

    // Naming the cause beats a generic retry message the person cannot act on.
    expect(screen.getByText('Offline. Will save when reconnected')).toBeInTheDocument();
  });

  it('saves immediately on reconnection rather than waiting out the backoff', async () => {
    const api = mockApi();
    const editor = await openFile();
    vi.useFakeTimers();

    api.fail(() =>
      json({ error: { code: 'SERVICE_UNAVAILABLE', message: 'no', requestId: 'r' } }, 503),
    );

    type(editor, 'start!');
    await advance(1_000);
    const duringOutage = api.writes().length;

    api.succeed();
    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    // No clock advance: reconnecting retries at once rather than serving out
    // the remaining backoff.
    await advance(0);

    expect(api.writes().length).toBeGreaterThan(duringOutage);
    expect(screen.getByText('Saved')).toBeInTheDocument();
  });

  it('never loses the text through an outage', async () => {
    // The whole point of the module.
    const api = mockApi();
    const editor = await openFile();
    vi.useFakeTimers();

    api.fail(() =>
      json({ error: { code: 'SERVICE_UNAVAILABLE', message: 'no', requestId: 'r' } }, 503),
    );

    type(editor, 'work in progress');
    await advance(20_000);
    expect(editor).toHaveValue('work in progress');

    api.succeed();
    await advance(60_000);

    expect(api.writes()[api.writes().length - 1]?.body?.content).toBe('work in progress');
  });
});
