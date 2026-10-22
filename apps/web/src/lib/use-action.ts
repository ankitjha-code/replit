import { useCallback, useEffect, useRef, useState } from 'react';

export type ActionOutcome<R> = { ok: true; value: R } | { ok: false; error: Error };

export interface Action<A extends unknown[], R> {
  /** Runs once at a time: a second press while busy returns the pending outcome. */
  run: (...args: A) => Promise<ActionOutcome<R>>;
  busy: boolean;
  error: Error | undefined;
  /** Clears the error, for a form that has been edited since it failed. */
  reset: () => void;
}

/**
 * One mutation with its own busy flag and error.
 *
 * Per action rather than per panel, so a table row can be busy on its own and
 * one failed action does not disable every button around it. The error is
 * returned as well as stored: a caller that needs to know whether to close a
 * dialog reads the outcome, and one that only renders reads the state.
 */
export function useAction<A extends unknown[], R>(fn: (...args: A) => Promise<R>): Action<A, R> {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | undefined>();
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const pending = useRef<Promise<ActionOutcome<R>> | undefined>(undefined);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = useCallback((...args: A): Promise<ActionOutcome<R>> => {
    if (pending.current) return pending.current;
    setBusy(true);
    setError(undefined);
    const attempt = (async (): Promise<ActionOutcome<R>> => {
      try {
        const value = await fnRef.current(...args);
        return { ok: true, value };
      } catch (cause) {
        const failure = cause instanceof Error ? cause : new Error(String(cause));
        if (mounted.current) setError(failure);
        return { ok: false, error: failure };
      } finally {
        pending.current = undefined;
        if (mounted.current) setBusy(false);
      }
    })();
    pending.current = attempt;
    return attempt;
  }, []);

  const reset = useCallback(() => setError(undefined), []);

  return { run, busy, error, reset };
}
