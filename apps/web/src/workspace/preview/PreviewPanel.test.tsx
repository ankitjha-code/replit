import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PreviewState, RuntimeStateResponse, RuntimeStatus } from '@platform/shared';
import { AuthProvider } from '../../lib/auth-context.js';
import { hasOpenedPreview } from '../../onboarding/use-onboarding.js';
import {
  NO_WORKSPACE_ACTIONS,
  WorkspaceActionsContext,
  type WorkspaceActions,
} from '../shell/workspace-actions.js';
import { PreviewPanel, STOPPED_TEXT } from './PreviewPanel.js';

/**
 * What the preview panel shows.
 *
 * The rule under test: nothing is presented as viewable until the server says
 * something answered on a port. A frame pointed at a page that does not load
 * is worse than being told what to do next.
 */

const PROJECT = '018f0000-0000-7000-8000-0000000000aa';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const runtimeState = (status?: RuntimeStatus): RuntimeStateResponse =>
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

const serving: PreviewState = {
  url: `http://${PROJECT}.localhost:4100/`,
  port: 3000,
  reason: null,
  candidatePorts: [3000, 8000],
  framable: true,
};

const notServing: PreviewState = {
  url: null,
  port: null,
  reason: 'Nothing is listening yet. Start a server in the terminal.',
  candidatePorts: [3000, 8000],
  framable: true,
};

const USER_ID = '018f0000-0000-7000-8000-000000000001';
const me = {
  id: USER_ID,
  email: 'ada@example.test',
  username: 'ada',
  displayName: null,
  emailVerified: true,
  isOperator: false,
  createdAt: '2026-01-01T00:00:00.000Z',
};

let grantSerial = 0;

function mockApi(
  state: PreviewState | (() => PreviewState),
  grantUrl = `http://${PROJECT}.localhost:4100/__x?t=abc`,
  { failState = false }: { failState?: boolean } = {},
) {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/auth/me')) return Promise.resolve(json({ user: me }));
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      if (url.endsWith('/grant')) {
        grantSerial += 1;
        return Promise.resolve(json({ url: grantUrl.replace('abc', `abc${grantSerial}`) }, 201));
      }
      if (failState) return Promise.resolve(json({ error: { code: 'INTERNAL' } }, 500));
      return Promise.resolve(json(typeof state === 'function' ? state() : state));
    }),
  );
  return { calls, grants: () => calls.filter((call) => call.includes('/grant')).length };
}

function harness(actions: Partial<WorkspaceActions> = {}) {
  const value = { ...NO_WORKSPACE_ACTIONS, ...actions };
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <AuthProvider>
        <WorkspaceActionsContext.Provider value={value}>
          {children}
        </WorkspaceActionsContext.Provider>
      </AuthProvider>
    );
  };
}

const panel = (status?: RuntimeStatus, actions: Partial<WorkspaceActions> = {}, canShare = false) =>
  render(<PreviewPanel projectId={PROJECT} runtime={runtimeState(status)} canShare={canShare} />, {
    wrapper: harness(actions),
  });

beforeEach(() => window.localStorage.clear());
afterEach(() => vi.unstubAllGlobals());

describe('with nothing running', () => {
  it('says to start the environment, then run the app', async () => {
    mockApi(notServing);
    panel();

    expect(await screen.findByText('Nothing to preview')).toBeInTheDocument();
    expect(screen.getByText(STOPPED_TEXT)).toBeInTheDocument();
  });

  it('points at Start with "Show me" rather than a second Start button', async () => {
    mockApi(notServing);
    const focusStart = vi.fn();
    panel(undefined, { focusStart });

    await userEvent.click(await screen.findByRole('button', { name: 'Show me' }));

    expect(focusStart).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: /start/i })).toBeNull();
  });

  it('does not ask the server what is served while nothing can be', async () => {
    const { calls } = mockApi(notServing);
    panel();
    await screen.findByText('Nothing to preview');

    expect(calls.filter((call) => call.includes('/preview'))).toHaveLength(0);
  });

  it('shows no frame at all', async () => {
    mockApi(notServing);
    const { container } = panel();
    await screen.findByText('Nothing to preview');

    expect(container.querySelector('iframe')).toBeNull();
  });

  it('asks for no grant it cannot use', async () => {
    // A one-time secret minted for a page nobody can see is a secret spent for
    // nothing.
    const { calls } = mockApi(notServing);
    panel();
    await screen.findByText('Nothing to preview');

    expect(calls.filter((call) => call.includes('/grant'))).toHaveLength(0);
  });
});

describe('running but serving nothing', () => {
  it('says nothing is listening, in the server own words', async () => {
    mockApi(notServing);
    panel('RUNNING');

    expect(await screen.findByText('Nothing to preview yet')).toBeInTheDocument();
    expect(
      screen.getByText(/Nothing is listening yet. Start a server in the terminal./),
    ).toBeInTheDocument();
  });
});

describe('serving something', () => {
  it('frames the preview at an address the server minted', async () => {
    // Built here it would be a guess. Minted there it carries the permission.
    mockApi(serving);
    const { container } = panel('RUNNING');

    await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull());
    // The minted address, exactly: one of the grants, never the bare page.
    expect(container.querySelector('iframe')?.getAttribute('src')).toMatch(
      new RegExp(`^http://${PROJECT}\\.localhost:4100/__x\\?t=abc\\d+$`),
    );
  });

  it('frames a different origin from the workspace', async () => {
    // The whole reason for a separate hostname. On this page's own origin the
    // project's code could read the API as the person looking at it.
    mockApi(serving);
    const { container } = panel('RUNNING');

    await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull());
    const src = container.querySelector('iframe')!.getAttribute('src')!;
    expect(new URL(src).origin).not.toBe(window.location.origin);
  });

  it('sandboxes the frame', async () => {
    mockApi(serving);
    const { container } = panel('RUNNING');

    await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull());
    const sandbox = container.querySelector('iframe')!.getAttribute('sandbox') ?? '';
    // Scripts yes, because an application needs them. Reaching out of the
    // frame no.
    expect(sandbox).toContain('allow-scripts');
    expect(sandbox).not.toContain('allow-top-navigation');
    expect(sandbox).not.toContain('allow-downloads');
  });

  it('names the port the application was found on', async () => {
    mockApi(serving);
    panel('RUNNING');

    expect(await screen.findByText('port 3000')).toBeInTheDocument();
  });

  it('reloads by minting a fresh address, because each one may be used once', async () => {
    const { calls } = mockApi(serving);
    panel('RUNNING');
    await screen.findByText('port 3000');
    const before = calls.filter((call) => call.includes('/grant')).length;

    await userEvent.click(screen.getByRole('button', { name: 'Reload' }));

    // Two more: the frame and the tab each need one of their own.
    await waitFor(() =>
      expect(calls.filter((call) => call.includes('/grant')).length).toBe(before + 2),
    );
  });

  it('says why there is no frame when the browser will not carry the cookie', async () => {
    // A preview is on its own site, so its cookie is a third-party one in a
    // frame, and a browser sends one of those only over HTTPS. Saying so beats
    // showing a frame that loads a refusal.
    mockApi({ ...serving, framable: false });
    const { container } = panel('RUNNING');

    expect(await screen.findByText(/will not\s+carry the preview/)).toBeInTheDocument();
    expect(container.querySelector('iframe')).toBeNull();
  });

  it('still offers the tab when the frame is unavailable', async () => {
    mockApi({ ...serving, framable: false });
    panel('RUNNING');

    expect(await screen.findByRole('link', { name: 'Open in a tab' })).toBeInTheDocument();
  });

  it('gives the tab its own address, because each one may be used once', async () => {
    // A tab opened on the address the frame already spent lands on a refusal.
    const { grants } = mockApi(serving);
    const { container } = panel('RUNNING');
    await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull());

    expect(grants()).toBe(2);
    expect(screen.getByRole('link', { name: 'Open in a tab' }).getAttribute('href')).not.toBe(
      container.querySelector('iframe')!.getAttribute('src'),
    );
  });

  it('offers a tab as well as a frame', async () => {
    // Browsers differ about cookies in a frame from another site. The tab is
    // the way out when one refuses.
    mockApi(serving);
    panel('RUNNING');

    const link = await screen.findByRole('link', { name: 'Open in a tab' });
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', expect.stringContaining('noreferrer'));
  });
});

describe('running but serving nothing, the next step', () => {
  it('names the ports it watches', async () => {
    mockApi(notServing);
    panel('RUNNING');

    expect(
      await screen.findByText(/looks on ports 3000, 5000, 5173, 8000, 8080 and 80/),
    ).toBeInTheDocument();
  });

  it('takes the person to the console and its Run button', async () => {
    mockApi(notServing);
    const showPanel = vi.fn();
    const selectConsoleTab = vi.fn();
    const focusRun = vi.fn();
    panel('RUNNING', { showPanel, selectConsoleTab, focusRun });

    await userEvent.click(await screen.findByRole('button', { name: 'Go to console' }));

    expect(showPanel).toHaveBeenCalledWith('console');
    expect(selectConsoleTab).toHaveBeenCalledWith('output');
    expect(focusRun).toHaveBeenCalledTimes(1);
  });

  it('says it could not check, with a retry, when the first read fails', async () => {
    mockApi(notServing, undefined, { failState: true });
    panel('RUNNING');

    expect(
      await screen.findByText('Could not check what this project is serving.'),
    ).toBeInTheDocument();

    mockApi(notServing);
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Nothing to preview yet')).toBeInTheDocument();
  });
});

describe('the address bar', () => {
  it('shows the URL with a copy button', async () => {
    mockApi(serving);
    panel('RUNNING');

    expect(await screen.findByRole('textbox', { name: 'Preview URL' })).toHaveValue(serving.url);
    expect(screen.getByRole('button', { name: 'Copy URL' })).toBeInTheDocument();
  });

  it('keeps "port {n}" as one text node', async () => {
    mockApi(serving);
    panel('RUNNING');

    const port = await screen.findByText('port 3000');
    expect(port.childNodes).toHaveLength(1);
  });
});

describe('telling the workspace what it found', () => {
  it('reports listening and framable, and nothing once it is gone', async () => {
    mockApi(serving);
    const reportPreview = vi.fn();
    const { unmount } = panel('RUNNING', { reportPreview });

    await waitFor(() =>
      expect(reportPreview).toHaveBeenLastCalledWith({ listening: true, framable: true }),
    );
    unmount();
    expect(reportPreview).toHaveBeenLastCalledWith(null);
  });

  it('reports that nothing is listening yet', async () => {
    mockApi(notServing);
    const reportPreview = vi.fn();
    panel('RUNNING', { reportPreview });

    await screen.findByText('Nothing to preview yet');
    expect(reportPreview).toHaveBeenLastCalledWith({ listening: false, framable: true });
  });
});

describe('after the app restarts', () => {
  it('looks again and mints fresh addresses, because the old page is gone', async () => {
    const { grants } = mockApi(serving);
    const { container, rerender } = render(
      <PreviewPanel projectId={PROJECT} runtime={runtimeState('RUNNING')} runNonce={1} />,
      { wrapper: harness() },
    );
    await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull());
    expect(grants()).toBe(2);
    const before = container.querySelector('iframe')!.getAttribute('src');

    rerender(<PreviewPanel projectId={PROJECT} runtime={runtimeState('RUNNING')} runNonce={2} />);

    await waitFor(() => expect(grants()).toBe(4));
    await waitFor(() =>
      expect(container.querySelector('iframe')?.getAttribute('src')).not.toBe(before),
    );
  });
});

describe('the getting-started checklist', () => {
  it('ticks "Open the preview" when the frame loads', async () => {
    mockApi(serving);
    const { container } = panel('RUNNING');
    await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull());
    // The account is read in the background; the tick needs to know whose it is.
    await waitFor(() =>
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/auth/me'),
        expect.anything(),
      ),
    );
    await act(async () => {});

    fireEvent.load(container.querySelector('iframe')!);

    expect(hasOpenedPreview(USER_ID)).toBe(true);
  });
});

describe('over plain HTTP', () => {
  const plain = { ...serving, framable: false };
  let tab: { opener: unknown; location: { href: string }; close: () => void };

  beforeEach(() => {
    tab = { opener: 'workspace', location: { href: '' }, close: vi.fn() };
    vi.spyOn(window, 'open').mockImplementation(() => tab as unknown as Window);
  });
  afterEach(() => vi.restoreAllMocks());

  it('makes "Open in a tab" the one primary action', async () => {
    mockApi(plain);
    const { container } = panel('RUNNING');

    const link = await screen.findByRole('link', { name: 'Open in a tab' });
    expect(link).toHaveClass('ui-button--primary');
    expect(container.querySelectorAll('.ui-button--primary')).toHaveLength(1);
  });

  it('opens a tab on a fresh address every click', async () => {
    const { grants } = mockApi(plain);
    panel('RUNNING');
    const link = await screen.findByRole('link', { name: 'Open in a tab' });
    await waitFor(() => expect(grants()).toBe(1));

    await userEvent.click(link);
    await waitFor(() => expect(tab.location.href).toMatch(/t=abc\d+$/));
    const first = tab.location.href;
    expect(tab.opener).toBeNull();

    await userEvent.click(link);
    await waitFor(() => expect(tab.location.href).not.toBe(first));
    expect(grants()).toBe(3);
  });

  it('ticks "Open the preview" when a tab is opened', async () => {
    mockApi(plain);
    panel('RUNNING');
    const link = await screen.findByRole('link', { name: 'Open in a tab' });
    await waitFor(() =>
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/auth/me'),
        expect.anything(),
      ),
    );
    await act(async () => {});

    await userEvent.click(link);

    expect(hasOpenedPreview(USER_ID)).toBe(true);
  });

  it('offers Share at the preview link for someone who can make one', async () => {
    mockApi(plain);
    const openShare = vi.fn();
    panel('RUNNING', { openShare }, true);

    await userEvent.click(await screen.findByRole('button', { name: 'Share this preview' }));
    expect(openShare).toHaveBeenCalledWith('preview-link');
    // Still one accent: Share is a link-style button beside it.
    expect(document.querySelectorAll('.ui-button--primary')).toHaveLength(1);
  });

  it('offers no Share to someone who cannot make a link', async () => {
    mockApi(plain);
    panel('RUNNING');
    await screen.findByRole('link', { name: 'Open in a tab' });
    expect(screen.queryByRole('button', { name: 'Share this preview' })).not.toBeInTheDocument();
  });

  it('mints no frame address, because there is no frame to spend it on', async () => {
    const { grants } = mockApi(plain);
    panel('RUNNING');
    await screen.findByRole('link', { name: 'Open in a tab' });

    await waitFor(() => expect(grants()).toBe(1));
  });
});
