import { useCallback, useEffect, useState } from 'react';

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
