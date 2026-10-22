import { createContext, useCallback, useContext } from 'react';

export type Announcement = { message: string; tone?: 'polite' | 'assertive' };

export type Announce = (message: string, tone?: 'polite' | 'assertive') => void;

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
