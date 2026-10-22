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

export const PHONE_PREVIEW_WIDTH = 390;

interface OpenInTabLinkProps {
  href: string | undefined;
  fallbackHref: string;
  mint: () => Promise<string>;
  onSpent: () => void;
  onOpened: () => void;
  variant: 'primary' | 'icon';
}

const BLOCKED = 'The browser blocked the new tab. Allow pop-ups for this site and press it again.';

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
  port: number;
  url: string;
  framable: boolean;
  onReload: () => void;
  tab: Omit<OpenInTabLinkProps, 'variant' | 'fallbackHref'>;
  device: PreviewDevice;
  onDeviceChange: (device: PreviewDevice) => void;
  onShare?: (() => void) | undefined;
}

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
