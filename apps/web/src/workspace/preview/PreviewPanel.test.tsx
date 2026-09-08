import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PreviewState, RuntimeStateResponse, RuntimeStatus } from '@platform/shared';
import { PreviewPanel } from './PreviewPanel.js';

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

function mockApi(state: PreviewState, grantUrl = `http://${PROJECT}.localhost:4100/__x?t=abc`) {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      if (url.endsWith('/grant')) return Promise.resolve(json({ url: grantUrl }, 201));
      return Promise.resolve(json(state));
    }),
  );
  return { calls };
}

const panel = (status?: RuntimeStatus) =>
  render(<PreviewPanel projectId={PROJECT} runtime={runtimeState(status)} />);

afterEach(() => vi.unstubAllGlobals());

describe('with nothing running', () => {
  it('says to start the project', async () => {
    mockApi(notServing);
    panel();

    expect(await screen.findByText('Nothing to preview')).toBeInTheDocument();
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
    expect(container.querySelector('iframe')?.getAttribute('src')).toBe(
      `http://${PROJECT}.localhost:4100/__x?t=abc`,
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
    const { calls } = mockApi(serving);
    panel('RUNNING');
    await screen.findByRole('link', { name: 'Open in a tab' });

    expect(calls.filter((call) => call.includes('/grant'))).toHaveLength(2);
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
