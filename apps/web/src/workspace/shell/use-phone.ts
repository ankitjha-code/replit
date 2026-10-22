import { useSyncExternalStore } from 'react';

export const PHONE_QUERY = '(max-width: 767px)';

function read(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(PHONE_QUERY).matches
    : false;
}

function subscribe(onChange: () => void): () => void {
  if (typeof window.matchMedia !== 'function') return () => undefined;
  const query = window.matchMedia(PHONE_QUERY);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

export function useIsPhone(): boolean {
  return useSyncExternalStore(subscribe, read, () => false);
}
