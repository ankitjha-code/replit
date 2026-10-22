import { createContext, useCallback, useContext } from 'react';

export type Announcement = { message: string; tone?: 'polite' | 'assertive' };

export type Announce = (message: string, tone?: 'polite' | 'assertive') => void;

/**
 * Speaks a message to screen readers through a surface's live region.
 *
 * Each surface (shell, workspace toolbar, a settings page) renders one region
 * and provides its writer through this context, so "Environment is running"
 * is read once, from the region nearest the change, rather than from three
 * regions that all re-render. Without a provider the message goes to a
 * document-level region created on demand, so nothing is ever lost.
 */
export const AnnounceContext = createContext<Announce | undefined>(undefined);

export function useAnnounce(): Announce {
  const provided = useContext(AnnounceContext);
  return useCallback(
    (message: string, tone: 'polite' | 'assertive' = 'polite') => {
      if (provided) provided(message, tone);
      else writeLiveRegion(fallbackRegion(tone), message);
    },
    [provided],
  );
}

/**
 * Writes so the same sentence twice is read twice. Live regions announce
 * changes, and setting identical text is not a change, so the region is
 * emptied first and filled on the next tick.
 */
export function writeLiveRegion(region: HTMLElement, message: string): void {
  region.textContent = '';
  setTimeout(() => {
    region.textContent = message;
  }, 0);
}

const FALLBACK_IDS = { polite: 'live-region-polite', assertive: 'live-region-assertive' } as const;

function fallbackRegion(tone: 'polite' | 'assertive'): HTMLElement {
  const id = FALLBACK_IDS[tone];
  const existing = document.getElementById(id);
  if (existing) return existing;
  const region = document.createElement('div');
  region.id = id;
  region.className = 'visually-hidden';
  region.setAttribute('aria-live', tone);
  region.setAttribute('aria-atomic', 'true');
  if (tone === 'assertive') region.setAttribute('role', 'alert');
  else region.setAttribute('role', 'status');
  document.body.appendChild(region);
  return region;
}
