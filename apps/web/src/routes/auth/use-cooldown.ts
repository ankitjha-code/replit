import { useCallback, useEffect, useState } from 'react';

/**
 * A countdown in whole seconds, for "Send another link" style buttons that
 * must not be pressed again straight away. `remaining` is 0 when it may.
 */
export function useCooldown(ms: number): { remaining: number; start: () => void } {
  const [remaining, setRemaining] = useState(0);

  useEffect(() => {
    if (remaining <= 0) return;
    const timer = setTimeout(() => setRemaining((current) => current - 1), 1000);
    return () => clearTimeout(timer);
  }, [remaining]);

  const start = useCallback(() => setRemaining(Math.ceil(ms / 1000)), [ms]);

  return { remaining, start };
}
