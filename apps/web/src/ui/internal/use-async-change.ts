import { useEffect, useRef, useState } from 'react';
import { toast } from '../Toast/toast-store.js';

export function useAsyncChange<T>(
  value: T | undefined,
  onChange: ((next: T) => void | Promise<void>) | undefined,
): { value: T | undefined; pending: boolean; change: (next: T) => void } {
  const [shown, setShown] = useState<T | undefined>(value);
  const [pending, setPending] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    setShown(value);
  }, [value]);

  const change = (next: T): void => {
    const previous = shown;
    setShown(next);
    const result = onChange?.(next);
    if (!result || typeof (result as Promise<void>).then !== 'function') return;
    setPending(true);
    (result as Promise<void>).then(
      () => {
        if (mounted.current) setPending(false);
      },
      (error: unknown) => {
        if (!mounted.current) return;
        setPending(false);
        setShown(previous);
        toast({
          tone: 'danger',
          title: 'That change did not save',
          description: error instanceof Error ? error.message : String(error),
        });
      },
    );
  };

  return { value: shown, pending, change };
}
