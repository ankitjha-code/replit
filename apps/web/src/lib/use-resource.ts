import { useCallback, useEffect, useRef, useState, type DependencyList } from 'react';

export type ResourceStatus = 'loading' | 'refreshing' | 'ready' | 'error';

export interface ResourceOptions<T> {
  poll?: number | ((data: T) => number | null);
  keepPrevious?: boolean;
}

export interface Resource<T> {
  status: ResourceStatus;
  data: T | undefined;
  error: Error | undefined;
  reload: () => void;
}

interface State<T> {
  status: ResourceStatus;
  data: T | undefined;
  error: Error | undefined;
}

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
  }, [...deps, nonce, keepPrevious]);

  const reload = useCallback(() => setNonce((value) => value + 1), []);

  return { status: state.status, data: state.data, error: state.error, reload };
}
