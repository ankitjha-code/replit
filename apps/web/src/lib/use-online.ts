import { useSyncExternalStore } from 'react';

/**
 * Whether the browser believes it has a network.
 *
 * `navigator.onLine` is optimistic: true means "not known to be offline". It
 * is still the right signal for the offline banner, because false is certain.
 */
export function useOnline(): boolean {
  return useSyncExternalStore(subscribe, readOnline, () => true);
}

function readOnline(): boolean {
  return typeof navigator === 'undefined' ? true : navigator.onLine;
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener('online', onChange);
  window.addEventListener('offline', onChange);
  return () => {
    window.removeEventListener('online', onChange);
    window.removeEventListener('offline', onChange);
  };
}
