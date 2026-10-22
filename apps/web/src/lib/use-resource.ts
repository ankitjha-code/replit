import { useCallback, useEffect, useRef, useState, type DependencyList } from 'react';

export type ResourceStatus = 'loading' | 'refreshing' | 'ready' | 'error';

export interface ResourceOptions<T> {
  /**
   * Milliseconds between reads once one has succeeded, or a function of the
   * data that returns null to stop. "Poll while the deployment is building" is
   * `poll: (state) => state.building ? 3000 : null`.
   */
  poll?: number | ((data: T) => number | null);
  /** Keep showing the old data while a reload or a change of key is in flight. Default true. */
  keepPrevious?: boolean;
}

export interface Resource<T> {
  status: ResourceStatus;
  data: T | undefined;
  error: Error | undefined;
  /** Reads again, keeping the current data on screen while it does. */
  reload: () => void;
}

interface State<T> {
  status: ResourceStatus;
  data: T | undefined;
  error: Error | undefined;
}

/**
 * One value read from the server, with the states every screen must render.
 *
 * The load function receives an AbortSignal and is called again whenever
 * `deps` change or `reload` is pressed. Aborting is handled here, once: a
 * result that arrives after unmount or after the key changed is dropped.
 *
 * A scheduled poll stays quiet (`ready` throughout) so a 3s refresh does not
 * flash a spinner; an explicit `reload` shows `refreshing`. A poll that fails
 * stops and reports the error, so the Retry button is the way back.
 */
export function useResource<T>(
  load: (signal: AbortSignal) => Promise<T>,
  deps: DependencyList,
  options: ResourceOptions<T> = {},
): Resource<T> {
  const { poll, keepPrevious = true } = options;
  const [state, setState] = useState<State<T>>({
    status: 'loading',
    data: undefined,
    error: undefined,
  });
  const [nonce, setNonce] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;
  const pollRef = useRef(poll);
  pollRef.current = poll;

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;

    const read = async (quiet: boolean): Promise<void> => {
      if (!quiet) {
        setState((previous) => {
          const showing = keepPrevious && previous.data !== undefined;
          return {
            status: showing ? 'refreshing' : 'loading',
            data: showing ? previous.data : undefined,
            error: undefined,
          };
        });
      }
      try {
        const data = await loadRef.current(controller.signal);
        if (controller.signal.aborted) return;
        setState({ status: 'ready', data, error: undefined });
        const delay =
          typeof pollRef.current === 'function' ? pollRef.current(data) : pollRef.current;
        if (delay != null && delay > 0) timer = setTimeout(() => void read(true), delay);
      } catch (cause) {
        if (controller.signal.aborted) return;
        const error = cause instanceof Error ? cause : new Error(String(cause));
        setState((previous) => ({
          status: 'error',
          data: keepPrevious ? previous.data : undefined,
          error,
        }));
      }
    };

    void read(false);

    return () => {
      controller.abort();
      if (timer !== undefined) clearTimeout(timer);
    };
    // The caller's deps are the key; `load` itself is read through a ref so an
    // inline arrow does not restart the read every render.
  }, [...deps, nonce, keepPrevious]);

  const reload = useCallback(() => setNonce((value) => value + 1), []);

  return { status: state.status, data: state.data, error: state.error, reload };
}
