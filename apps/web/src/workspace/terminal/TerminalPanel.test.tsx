import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { RuntimeStateResponse, RuntimeStatus } from '@platform/shared';
import { TerminalPanel, TerminalStatusLine } from './TerminalPanel.js';
import type { TerminalStatus } from './terminal-connection.js';

/**
 * What the console says when there is no terminal to show.
 *
 * Only the states without a live terminal are covered here. xterm draws to a
 * canvas and measures a font, neither of which jsdom has, so the working
 * terminal is exercised in a real browser instead of approximated in one that
 * cannot render it.
 */

const PROJECT = '018f0000-0000-7000-8000-0000000000aa';

const state = (status?: RuntimeStatus): RuntimeStateResponse =>
  ({
    runtime: status
      ? {
          id: 'r1',
          projectId: PROJECT,
          status,
          language: 'node',
          version: '22',
          image: 'node:22',
          limits: { cpuMillicores: 1000, memoryMb: 1024, pidsLimit: 256 },
          message: null,
          createdAt: '2026-01-01T00:00:00.000Z',
          statusChangedAt: '2026-01-01T00:00:00.000Z',
          startedAt: null,
          stoppedAt: null,
        }
      : null,
    detected: null,
    provider: { name: 'docker', available: true, reason: null },
  }) as RuntimeStateResponse;

const panel = (props: Partial<Parameters<typeof TerminalPanel>[0]> = {}) =>
  render(<TerminalPanel projectId={PROJECT} runtime={state()} canAttach={true} {...props} />);

describe('with nothing running', () => {
  it('says so, rather than showing an empty black rectangle', () => {
    // An empty terminal and a terminal that does not exist look identical, and
    // one of them takes typing.
    panel({ runtime: state() });
    expect(screen.getByText('Nothing is running')).toBeInTheDocument();
  });

  it('says where a command would run, before anyone runs one', () => {
    panel({ runtime: state() });
    expect(screen.getByText(/inside the project's own container/)).toBeInTheDocument();
    expect(screen.getByText(/never on the platform/)).toBeInTheDocument();
  });

  it('says the same while the runtime is still starting', () => {
    // Attaching to a container that is not up yet fails in a way nobody can
    // act on. Waiting is the honest state.
    panel({ runtime: state('STARTING') });
    expect(screen.getByText('Nothing is running')).toBeInTheDocument();
  });

  it('says the same for a runtime that failed', () => {
    panel({ runtime: state('FAILED') });
    expect(screen.getByText('Nothing is running')).toBeInTheDocument();
  });

  it('says the same before the runtime state has arrived', () => {
    panel({ runtime: undefined });
    expect(screen.getByText('Nothing is running')).toBeInTheDocument();
  });
});

describe('without permission', () => {
  it('offers no terminal to someone with read-only access', () => {
    // The server refuses the socket too. This is so the person is told why,
    // rather than watching a connection fail.
    panel({ runtime: state('RUNNING'), canAttach: false });

    expect(screen.getByText('No terminal')).toBeInTheDocument();
    expect(screen.getByText(/read-only access/)).toBeInTheDocument();
  });

  it('says nothing about running, because that is not the obstacle', () => {
    panel({ runtime: state('RUNNING'), canAttach: false });
    expect(screen.queryByText('Nothing is running')).not.toBeInTheDocument();
  });
});

/**
 * The line under the terminal.
 *
 * Exercised directly rather than through the panel, because reaching it that
 * way needs xterm, which needs a canvas and a font that jsdom does not have.
 * What it says is a rule, not a rendering detail: two of these sentences are
 * the only way a person learns something they could not otherwise know.
 */
describe('the status line', () => {
  const line = (status: TerminalStatus, noteDismissed = false) =>
    render(
      <TerminalStatusLine
        status={status}
        noteDismissed={noteDismissed}
        onDismissNote={() => undefined}
        onReconnect={() => undefined}
        onStartFresh={() => undefined}
      />,
    );

  const ready = (over: Partial<Extract<TerminalStatus, { state: 'ready' }>> = {}) =>
    ({ state: 'ready', sessionId: 's1', resumed: false, truncated: false, ...over }) as const;

  it('says nothing about a shell that just opened', () => {
    // A fresh prompt showing everything it has printed needs no commentary.
    line(ready());
    expect(screen.queryByText(/Reattached/)).not.toBeInTheDocument();
    expect(screen.queryByText(/dropped/)).not.toBeInTheDocument();
  });

  it('still offers a way to abandon a working shell', () => {
    // The one that is wedged is the one that still reports itself ready, so
    // this control cannot live only on the broken states.
    line(ready());
    expect(screen.getByRole('button', { name: 'New terminal' })).toBeInTheDocument();
  });

  it('says a shell was reattached, so it is not mistaken for a fresh one', () => {
    line(ready({ resumed: true }));
    expect(screen.getByText(/Reattached to the terminal you already had open/)).toBeInTheDocument();
  });

  it('says when the screen above it is not everything the shell printed', () => {
    // A partial screen presented as a whole one is how someone concludes a
    // command printed nothing.
    line(ready({ resumed: true, truncated: true }));
    expect(screen.getByText(/Some earlier output was dropped/)).toBeInTheDocument();
  });

  it('warns about dropped output even on a shell it did not resume', () => {
    line(ready({ resumed: false, truncated: true }));
    expect(screen.getByText(/Some earlier output was dropped/)).toBeInTheDocument();
  });

  it('goes away once the note has been dismissed', () => {
    line(ready({ resumed: true }), true);
    expect(screen.queryByText(/Reattached/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Dismiss' })).not.toBeInTheDocument();
  });

  it('offers no reconnect on a working terminal, because there is nothing to fix', () => {
    line(ready({ resumed: true }));
    expect(screen.queryByRole('button', { name: 'Reconnect' })).not.toBeInTheDocument();
  });

  it('names the code a shell exited with, rather than just saying it ended', () => {
    line({ state: 'ended', code: 127 });
    expect(screen.getByText(/exited with code 127/)).toBeInTheDocument();
  });

  it('offers a way to throw a wedged shell away and start another', () => {
    // Needed precisely because closing the panel no longer ends anything.
    line({ state: 'closed' });
    expect(screen.getByRole('button', { name: 'New terminal' })).toBeInTheDocument();
  });

  it('offers nothing to press while it is still connecting', () => {
    line({ state: 'connecting' });
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('shows the reason a connection was refused, in words', () => {
    line({ state: 'failed', message: 'That terminal is no longer open.' });
    expect(screen.getByText('That terminal is no longer open.')).toBeInTheDocument();
  });
});
