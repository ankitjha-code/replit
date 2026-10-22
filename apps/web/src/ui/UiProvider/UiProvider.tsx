import type { ReactElement, ReactNode } from 'react';
import { Tooltip as TooltipPrimitive } from 'radix-ui';
import { Toaster } from '../Toast/Toast.js';
import { TOOLTIP_DELAY_MS, TooltipScopeContext } from '../Tooltip/Tooltip.js';
import { IconContext } from '../icons.js';

export interface UiProviderProps {
  children: ReactNode;
  toasts?: boolean;
}

export function UiProvider({ children, toasts = true }: UiProviderProps): ReactElement {
  return (
    <IconContext.Provider value={{ size: 16, weight: 'regular' }}>
      <TooltipPrimitive.Provider delayDuration={TOOLTIP_DELAY_MS} skipDelayDuration={300}>
        <TooltipScopeContext.Provider value={true}>
          {children}
          {toasts ? <Toaster /> : null}
        </TooltipScopeContext.Provider>
      </TooltipPrimitive.Provider>
    </IconContext.Provider>
  );
}
