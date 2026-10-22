import { useCallback, useState } from 'react';

export function usePatched<T>(base: T | undefined): [T | undefined, (next: T) => void] {
  const [patch, setPatch] = useState<{ base: T | undefined; value: T } | undefined>();
  const value = patch !== undefined && patch.base === base ? patch.value : base;
  const set = useCallback((next: T) => setPatch({ base, value: next }), [base]);
  return [value, set];
}
