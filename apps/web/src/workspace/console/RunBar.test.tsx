import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { RunState } from '@platform/shared';
import { RunBar, StatusBadge } from './RunBar.js';
import type { RunControls } from './use-run.js';

/** The App half of the run strip, driven by a hand-made run state. */

const state = (over: Partial<RunState> = {}): RunState => ({
  status: 'IDLE',
  command: null,
  configuredCommand: null,
  suggestion: { command: 'node index.js', reason: 'index.js' },
  startedAt: null,
  exitedAt: null,
  exitCode: null,
  message: null,
  blockedReason: null,
  ...over,
});

const controls = (over: Partial<RunState> = {}, extra: Partial<RunControls> = {}): RunControls => ({
  state: state(over),
  lines: [],
  truncated: false,
  loading: false,
  loadFailed: false,
  busy: false,
  error: undefined,
  connection: 'open',
  start: vi.fn(() => Promise.resolve()),
  stop: vi.fn(() => Promise.resolve()),
  restart: vi.fn(() => Promise.resolve()),
  setCommand: vi.fn(() => Promise.resolve()),
  clear: vi.fn(),
  refresh: vi.fn(() => Promise.resolve()),
  ...extra,
});

const bar = (
  run: RunControls,
  runtimeRunning = true,
  canControl = true,
  extra: { compact?: boolean; demoted?: boolean } = {},
) =>
  render(
    <RunBar
      run={run}
      canControl={canControl}
      runtimeRunning={runtimeRunning}
      editing={false}
      onEditingChange={() => undefined}
      {...extra}
    />,
  );

describe('the App half of the run strip', () => {
  it('is a named group, so it reads as one control', () => {
    bar(controls());
    expect(screen.getByRole('group', { name: 'App controls' })).toBeInTheDocument();
  });

  it('labels a suggested command as a suggestion', () => {
    bar(controls());
    expect(screen.getByText('Suggested')).toBeInTheDocument();
    expect(screen.getByTitle(/Suggested by the platform, from index.js/)).toHaveTextContent(
      'node index.js',
    );
  });

  it('labels a command the project set as set', () => {
    bar(controls({ configuredCommand: 'make serve' }));
    expect(screen.getByText('Set')).toBeInTheDocument();
  });

  it('says the environment comes first, in words that differ from the empty state', () => {
    bar(controls(), false);
    const run = screen.getByRole('button', { name: 'Run' });
    expect(run).toBeDisabled();
    expect(run).toHaveAttribute('title', 'Start the environment first.');
  });

  it('offers Restart app and Stop while the app runs', () => {
    bar(controls({ status: 'RUNNING', command: 'node index.js' }));
    expect(screen.getByRole('button', { name: 'Restart app' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Stop' })).toHaveClass('ui-button--secondary');
  });

  it('lights Run while the environment runs and nothing else answers', () => {
    bar(controls());
    expect(screen.getByRole('button', { name: 'Run' })).toHaveClass('ui-button--primary');
  });

  it('gives the accent away while a server started elsewhere already answers', () => {
    // The preview's "Open in a tab" is the next step then; two lit buttons
    // would make it a guess.
    bar(controls(), true, true, { demoted: true });
    const run = screen.getByRole('button', { name: 'Run' });
    expect(run).toHaveClass('ui-button--secondary');
    expect(run).toBeEnabled();
  });

  it('keeps the same Run element when its reason comes and goes', () => {
    const view = bar(controls(), false);
    const before = screen.getByRole('button', { name: 'Run' });
    expect(before).toBeDisabled();

    view.rerender(
      <RunBar
        run={controls()}
        canControl
        runtimeRunning
        editing={false}
        onEditingChange={() => undefined}
      />,
    );
    const after = screen.getByRole('button', { name: 'Run' });
    expect(after).toBe(before);
    expect(after).toBeEnabled();
  });

  it('leaves the command out when compact, keeping the state and Run', () => {
    bar(controls(), true, true, { compact: true });
    expect(screen.queryByText('node index.js')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(screen.getByText('Not running')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Run' })).toBeEnabled();
  });

  it('says it is reconnecting rather than going quiet', () => {
    bar(controls({}, { connection: 'reconnecting' }));
    expect(screen.getByText('Reconnecting to output…')).toBeInTheDocument();
  });
});

describe('the App state word', () => {
  // The words themselves are pinned by the browser tests.
  it.each([
    ['IDLE', null, 'Not running'],
    ['STARTING', null, 'Starting…'],
    ['RUNNING', null, 'Running'],
    ['EXITED', 0, 'Stopped'],
    ['FAILED', 3, 'Exited 3'],
    ['FAILED', null, 'Failed'],
  ] as const)('%s with exit code %s reads %s', (status, exitCode, word) => {
    render(<StatusBadge status={status} exitCode={exitCode} />);
    expect(screen.getByText(word, { exact: true })).toBeInTheDocument();
  });

  it('marks a clean exit as clean', () => {
    render(<StatusBadge status="EXITED" exitCode={0} />);
    expect(screen.getByText('exit 0')).toBeInTheDocument();
  });
});
