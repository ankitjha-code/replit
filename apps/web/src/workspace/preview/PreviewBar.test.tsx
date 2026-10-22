import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearToasts, Toaster } from '../../ui/index.js';
import { OpenInTabLink, PreviewBar } from './PreviewBar.js';

const URL_ = 'http://p.localhost:4100/';

function link(overrides: Partial<Parameters<typeof OpenInTabLink>[0]> = {}) {
  const props = {
    href: `${URL_}__x?t=pre`,
    fallbackHref: URL_,
    mint: vi.fn(() => Promise.resolve(`${URL_}__x?t=fresh`)),
    onSpent: vi.fn(),
    onOpened: vi.fn(),
    variant: 'primary' as const,
    ...overrides,
  };
  render(
    <>
      <OpenInTabLink {...props} />
      <Toaster />
    </>,
  );
  return props;
}

let tab: { opener: unknown; location: { href: string }; close: ReturnType<typeof vi.fn> };

beforeEach(() => {
  tab = { opener: 'workspace', location: { href: '' }, close: vi.fn() };
  vi.spyOn(window, 'open').mockImplementation(() => tab as unknown as Window);
});
afterEach(() => {
  vi.restoreAllMocks();
  clearToasts();
});

describe('Open in a tab', () => {
  it('is a real link to a new tab, with no referrer and no opener', () => {
    link();
    const anchor = screen.getByRole('link', { name: 'Open in a tab' });

    expect(anchor).toHaveAttribute('target', '_blank');
    expect(anchor).toHaveAttribute('rel', 'noreferrer noopener');
    expect(anchor).toHaveAttribute('href', `${URL_}__x?t=pre`);
  });

  it('is still a link before anything is minted', () => {
    link({ href: undefined });

    expect(screen.getByRole('link', { name: 'Open in a tab' })).toHaveAttribute('href', URL_);
  });

  it('mints a fresh address on a plain click and sends the tab there', async () => {
    const props = link();

    await userEvent.click(screen.getByRole('link', { name: 'Open in a tab' }));

    expect(window.open).toHaveBeenCalledWith('', '_blank');
    await waitFor(() => expect(tab.location.href).toBe(`${URL_}__x?t=fresh`));
    expect(tab.opener).toBeNull();
    expect(props.mint).toHaveBeenCalledTimes(1);
    expect(props.onOpened).toHaveBeenCalledTimes(1);
    expect(props.onSpent).not.toHaveBeenCalled();
  });

  it('lets the browser use the pre-minted address on a modified click, then replaces it', () => {
    const props = link();
    const anchor = screen.getByRole('link', { name: 'Open in a tab' });

    const event = new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true });
    anchor.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(window.open).not.toHaveBeenCalled();
    expect(props.onSpent).toHaveBeenCalledTimes(1);
  });

  it('treats a middle-click the same way', () => {
    const props = link();

    fireEvent(
      screen.getByRole('link', { name: 'Open in a tab' }),
      new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }),
    );

    expect(props.onSpent).toHaveBeenCalledTimes(1);
    expect(props.mint).not.toHaveBeenCalled();
  });

  it('ignores a right-click, which only opens the context menu', () => {
    const props = link();

    fireEvent(
      screen.getByRole('link', { name: 'Open in a tab' }),
      new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 2 }),
    );

    expect(props.onSpent).not.toHaveBeenCalled();
    expect(props.onOpened).not.toHaveBeenCalled();
  });

  it('says so when the browser blocks the tab', async () => {
    vi.mocked(window.open).mockReturnValue(null);
    const props = link();

    await userEvent.click(screen.getByRole('link', { name: 'Open in a tab' }));

    expect(await screen.findByText(/blocked the new tab/)).toBeInTheDocument();
    expect(props.mint).not.toHaveBeenCalled();
  });

  it('closes the empty tab and says so when no address can be minted', async () => {
    link({ mint: vi.fn(() => Promise.reject(new Error('down'))) });

    await userEvent.click(screen.getByRole('link', { name: 'Open in a tab' }));

    expect(await screen.findByText(/did not answer/)).toBeInTheDocument();
    expect(tab.close).toHaveBeenCalledTimes(1);
  });
});

describe('the bar', () => {
  const bar = (framable: boolean, onShare?: () => void) =>
    render(
      <PreviewBar
        port={8000}
        url={URL_}
        framable={framable}
        onReload={vi.fn()}
        tab={{ href: undefined, mint: vi.fn(), onSpent: vi.fn(), onOpened: vi.fn() }}
        device="desktop"
        onDeviceChange={vi.fn()}
        onShare={onShare}
      />,
    );

  it('opens Share from the bar when the person can make a preview link', async () => {
    const onShare = vi.fn();
    bar(true, onShare);
    await userEvent.click(screen.getByRole('button', { name: 'Share this preview' }));
    expect(onShare).toHaveBeenCalledTimes(1);
  });

  it('has no Share for someone who cannot make a link', () => {
    bar(true);
    expect(screen.queryByRole('button', { name: 'Share this preview' })).not.toBeInTheDocument();
  });

  it('shows the port, the URL and a copy button', () => {
    bar(true);

    expect(screen.getByText('port 8000')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Preview URL' })).toHaveValue(URL_);
    expect(screen.getByRole('button', { name: 'Copy URL' })).toBeInTheDocument();
  });

  it('offers Reload, a tab and the width toggle beside a frame', () => {
    bar(true);

    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open in a tab' })).toBeInTheDocument();
    expect(screen.getByLabelText('Preview width')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Phone width, 390px' })).toBeInTheDocument();
  });

  it('leaves the tab to the panel when there is no frame, so it appears once', () => {
    bar(false);

    expect(screen.queryByRole('link', { name: 'Open in a tab' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reload' })).toBeNull();
  });
});
