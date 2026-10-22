import { useSyncExternalStore } from 'react';

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
