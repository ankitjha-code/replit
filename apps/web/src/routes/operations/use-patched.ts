import { useCallback, useState } from 'react';

/**
 * A resource's data with a local replacement layered on top.
 *
 * A mutation here answers with the new state of the whole list (every host
 * after a drain, every limit after a change), and showing that answer is
 * better than reading the list again. The replacement is tied to the data
 * object it replaced, so the next reload drops it on its own.
 */
export function usePatched<T>(base: T | undefined): [T | undefined, (next: T) => void] {
  const [patch, setPatch] = useState<{ base: T | undefined; value: T } | undefined>();
  const value = patch !== undefined && patch.base === base ? patch.value : base;
  const set = useCallback((next: T) => setPatch({ base, value: next }), [base]);
  return [value, set];
}
