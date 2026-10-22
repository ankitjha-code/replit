import { act, render, screen } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ConnectionBanner,
  OFFLINE_MESSAGE,
  RECONNECTING_MESSAGE,
  RECONNECT_GRACE_MS,
  ShellBannerProvider,
  useShellBanner,
} from './ConnectionBanner.js';

/** Stands in for the workspace reporting its project stream. */
function Socket({ connected }: { connected: boolean | null }): null {
  const { setSocketConnected } = useShellBanner();
  useEffect(() => {
    setSocketConnected(connected);
    return () => setSocketConnected(null);
  }, [connected, setSocketConnected]);
  return null;
}

const renderBanner = (connected: boolean | null) =>
  render(
    <ShellBannerProvider>
      <Socket connected={connected} />
      <ConnectionBanner />
    </ShellBannerProvider>,
  );

describe('ConnectionBanner', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('{}', { status: 200 }))),
    );
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('shows nothing while connected', () => {
    renderBanner(true);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('waits out a short socket drop, then says it is reconnecting', () => {
    const { rerender } = renderBanner(false);
    act(() => {
      vi.advanceTimersByTime(RECONNECT_GRACE_MS - 500);
    });
    expect(screen.queryByText(RECONNECTING_MESSAGE)).toBeNull();

    act(() => {
      vi.advanceTimersByTime(600);
    });
    // Reconnecting is a status, never an alert.
    expect(screen.getByRole('status')).toHaveTextContent(RECONNECTING_MESSAGE);

    rerender(
      <ShellBannerProvider>
        <Socket connected={true} />
        <ConnectionBanner />
      </ShellBannerProvider>,
    );
    expect(screen.queryByText(RECONNECTING_MESSAGE)).toBeNull();
  });

  it('says so when the browser is offline, and clears when it is back', () => {
    const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    renderBanner(true);
    act(() => {
      window.dispatchEvent(new Event('offline'));
    });
    expect(screen.getByText(OFFLINE_MESSAGE)).toBeInTheDocument();

    onLine.mockReturnValue(true);
    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    expect(screen.queryByText(OFFLINE_MESSAGE)).toBeNull();
  });
});
