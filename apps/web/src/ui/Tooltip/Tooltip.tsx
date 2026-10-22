import { createContext, useContext, type ReactElement, type ReactNode } from 'react';
import { Tooltip as Primitive } from 'radix-ui';
import { Kbd } from '../Kbd/Kbd.js';
import { lastInputWasKeyboard } from '../internal/input-modality.js';
import { portalRoot } from '../internal/portal.js';
import './Tooltip.css';

export type TooltipSide = 'top' | 'right' | 'bottom' | 'left';

export interface TooltipProps {
  content: ReactNode;
  /** Shown as a Kbd after the content. */
  shortcut?: string[];
  side?: TooltipSide;
  /** The trigger. It must accept a ref and spread its props (a Button, an IconButton, a span). */
  children: ReactElement;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export const TOOLTIP_DELAY_MS = 400;

/** True inside UiProvider, which already mounts the Radix tooltip provider. */
export const TooltipScopeContext = createContext(false);

/**
 * A tooltip is never the only place a reason lives: the trigger carries its
 * own accessible name and any reason is also in aria-describedby text.
 */
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
          // Focus from a click or a dialog's auto-focus is not a request for help.
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
  // Outside UiProvider (unit tests, isolated mounts) each tooltip brings its own provider.
  return <Primitive.Provider delayDuration={TOOLTIP_DELAY_MS}>{tooltip}</Primitive.Provider>;
}
