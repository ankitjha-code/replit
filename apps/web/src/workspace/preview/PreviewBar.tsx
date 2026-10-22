import { useState, type MouseEvent, type ReactElement } from 'react';
import {
  Button,
  CopyButton,
  IconButton,
  Input,
  SegmentedControl,
  Tooltip,
  toast,
} from '../../ui/index.js';
import {
  ArrowClockwise,
  ArrowSquareOut,
  Browser,
  DeviceMobile,
  Monitor,
  ShareNetwork,
} from '../../ui/icons.js';

export type PreviewDevice = 'desktop' | 'phone';

/** The width the "phone" device toggle narrows the frame to (spec 9.8). */
export const PHONE_PREVIEW_WIDTH = 390;

interface OpenInTabLinkProps {
  /**
   * An address minted ahead of time. Used only when the browser handles the
   * click itself (middle-click, a modifier, "open in new tab" from the context
   * menu); a plain click mints its own.
   */
  href: string | undefined;
  /** The page with no grant, so the element is a real link even before one is minted. */
  fallbackHref: string;
  /** Mints a one-time address for a new tab. */
  mint: () => Promise<string>;
  /** The pre-minted address was handed to the browser and is spent. */
  onSpent: () => void;
  /** Any open, for the getting-started checklist. */
  onOpened: () => void;
  variant: 'primary' | 'icon';
}

const BLOCKED = 'The browser blocked the new tab. Allow pop-ups for this site and press it again.';

/**
 * "Open in a tab": a real link, so it reads and behaves as one, whose plain
 * click mints a fresh one-time address every time.
 *
 * A grant lives for a minute and may be used once, so an address minted when
 * the panel opened is likely dead by the time someone clicks. The tab is
 * opened synchronously inside the click (so no pop-up blocker objects) and
 * pointed at the new address once the server has minted it.
 */
export function OpenInTabLink({
  href,
  fallbackHref,
  mint,
  onSpent,
  onOpened,
  variant,
}: OpenInTabLinkProps): ReactElement {
  const [busy, setBusy] = useState(false);

  const onClick = (event: MouseEvent<HTMLAnchorElement>): void => {
    // A right-click is an auxclick too; only the middle button opens anything.
    if (event.type === 'auxclick' && event.button !== 1) return;
    onOpened();
    const browserHandles =
      event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;
    if (browserHandles) {
      if (href) onSpent();
      return;
    }
    event.preventDefault();
    if (busy) return;

    const tab = window.open('', '_blank');
    if (!tab) {
      toast({ tone: 'danger', title: 'The preview did not open', description: BLOCKED });
      return;
    }
    // The preview is someone's own code on another origin; it gets no handle
    // back to the workspace, which is what rel="noopener" would have done.
    tab.opener = null;
    setBusy(true);
    mint()
      .then((url) => {
        tab.location.href = url;
      })
      .catch(() => {
        tab.close();
        toast({
          tone: 'danger',
          title: 'The preview did not open',
          description: 'The server did not answer. Press it again.',
        });
      })
      .finally(() => setBusy(false));
  };

  const anchor = (
    <a
      href={href ?? fallbackHref}
      target="_blank"
      rel="noreferrer noopener"
      onClick={onClick}
      onAuxClick={onClick}
      {...(variant === 'icon' ? { 'aria-label': 'Open in a tab' } : {})}
    >
      {variant === 'primary' ? 'Open in a tab' : null}
    </a>
  );

  if (variant === 'primary') {
    return (
      <Button asChild variant="primary" icon={ArrowSquareOut} loading={busy}>
        {anchor}
      </Button>
    );
  }
  return (
    <Tooltip content="Open in a tab">
      <Button
        asChild
        variant="ghost"
        size="sm"
        icon={ArrowSquareOut}
        loading={busy}
        className="ui-button--icon preview-bar__tab"
      >
        {anchor}
      </Button>
    </Tooltip>
  );
}

interface PreviewBarProps {
  /** The port inside the environment the app was found on. */
  port: number;
  /** The preview's own address (the page, not a grant). */
  url: string;
  /** The frame can be shown; otherwise only the address row appears here. */
  framable: boolean;
  onReload: () => void;
  tab: Omit<OpenInTabLinkProps, 'variant' | 'fallbackHref'>;
  device: PreviewDevice;
  onDeviceChange: (device: PreviewDevice) => void;
  /** Opens Share at its preview link; absent for people who cannot make one. Framed only. */
  onShare?: (() => void) | undefined;
}

/**
 * The row above the frame (spec 9.8): which port, the address with a copy,
 * Reload, a tab, and the width the page is shown at.
 */
export function PreviewBar({
  port,
  url,
  framable,
  onReload,
  tab,
  device,
  onDeviceChange,
  onShare,
}: PreviewBarProps): ReactElement {
  return (
    <div className="preview-bar">
      <Browser size={16} aria-hidden="true" className="preview-bar__icon" />
      {/* The port the app was actually found on, not one assumed. */}
      <span className="preview-bar__port">{`port ${port}`}</span>
      <Input
        size="sm"
        mono
        readOnly
        value={url}
        aria-label="Preview URL"
        className="preview-bar__url"
        onFocus={(event) => event.currentTarget.select()}
        trailing={<CopyButton value={url} label="Copy URL" size="sm" />}
      />
      {framable ? (
        <>
          <IconButton
            label="Reload"
            icon={ArrowClockwise}
            size="sm"
            onClick={onReload}
            className="preview-bar__reload"
          />
          <OpenInTabLink {...tab} fallbackHref={url} variant="icon" />
          <SegmentedControl
            className="preview-bar__device"
            size="sm"
            label="Preview width"
            value={device}
            onValueChange={(value) => onDeviceChange(value as PreviewDevice)}
            items={[
              { value: 'desktop', label: 'Full width', icon: Monitor, iconOnly: true },
              {
                value: 'phone',
                label: `Phone width, ${PHONE_PREVIEW_WIDTH}px`,
                icon: DeviceMobile,
                iconOnly: true,
              },
            ]}
          />
        </>
      ) : null}
      {/* Over plain HTTP the panel below offers it, beside Open in a tab. */}
      {onShare && framable ? (
        <IconButton
          label="Share this preview"
          icon={ShareNetwork}
          size="sm"
          onClick={onShare}
          className="preview-bar__share"
        />
      ) : null}
    </div>
  );
}
