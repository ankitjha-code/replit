import { createContext, useContext, type ReactElement, type ReactNode } from 'react';
import { Tooltip as Primitive } from 'radix-ui';
import { Kbd } from '../Kbd/Kbd.js';
import { lastInputWasKeyboard } from '../internal/input-modality.js';
import { portalRoot } from '../internal/portal.js';
import './Tooltip.css';

export type TooltipSide = 'top' | 'right' | 'bottom' | 'left';

export interface TooltipProps {
  content: ReactNode;
  shortcut?: string[];
  side?: TooltipSide;
  children: ReactElement;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export const TOOLTIP_DELAY_MS = 400;

export const TooltipScopeContext = createContext(false);

export function Tooltip({
  content,
  shortcut,
  side = 'top',
  children,
  open,
  defaultOpen,
  onOpenChange,
}: TooltipProps): ReactElement {
  const scoped = useContext(TooltipScopeContext);
  const rootProps = {
    ...(open !== undefined ? { open } : {}),
    ...(defaultOpen !== undefined ? { defaultOpen } : {}),
    ...(onOpenChange ? { onOpenChange } : {}),
  };
  const tooltip = (
    <Primitive.Root {...rootProps}>
      <Primitive.Trigger
        asChild
        onFocus={(event) => {
          if (!lastInputWasKeyboard()) event.preventDefault();
        }}
      >
        {children}
      </Primitive.Trigger>
      <Primitive.Portal container={portalRoot()}>
        <Primitive.Content
          className="ui-tooltip"
          side={side}
          sideOffset={6}
          collisionPadding={8}
          data-ui-portal="tooltip"
        >
          <span className="ui-tooltip__content">{content}</span>
          {shortcut ? <Kbd keys={shortcut} className="ui-tooltip__kbd" /> : null}
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
  if (scoped) return tooltip;
  return <Primitive.Provider delayDuration={TOOLTIP_DELAY_MS}>{tooltip}</Primitive.Provider>;
}
