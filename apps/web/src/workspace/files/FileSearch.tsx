import { useEffect, useRef, useState, type ReactElement, type Ref } from 'react';
import { parentOf, type SearchResult } from '@platform/shared';
import { ApiError } from '../../lib/api-client.js';
import { searchFiles } from '../../lib/files-api.js';
import { formatCount } from '../../lib/format.js';
import { Button, Callout, EmptyState, IconButton, Input, Skeleton } from '../../ui/index.js';
import { MagnifyingGlass, X } from '../../ui/icons.js';

export const SEARCH_DEBOUNCE_MS = 200;
export const SEARCH_MIN_LENGTH = 2;

export type FileSearchState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; results: SearchResult[]; truncated: boolean }
  | { status: 'error'; message: string; retry: () => void };

export function useFileSearch(projectId: string, query: string): FileSearchState {
  const trimmed = query.trim();
  const [debounced, setDebounced] = useState(trimmed);
  const [nonce, setNonce] = useState(0);
  const [state, setState] = useState<FileSearchState>({ status: 'idle' });

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(trimmed), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [trimmed]);

  useEffect(() => {
    if (debounced.length < SEARCH_MIN_LENGTH) {
      setState({ status: 'idle' });
      return;
    }
    const controller = new AbortController();
    setState({ status: 'loading' });
    searchFiles(projectId, debounced, controller.signal)
      .then((response) =>
        setState({ status: 'ready', results: response.results, truncated: response.truncated }),
      )
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          status: 'error',
          message: cause instanceof ApiError ? cause.message : 'The files could not be searched.',
          retry: () => setNonce((value) => value + 1),
        });
      });
    return () => controller.abort();
  }, [projectId, debounced, nonce]);

  if (trimmed.length >= SEARCH_MIN_LENGTH && trimmed !== debounced) return { status: 'loading' };
  return trimmed.length < SEARCH_MIN_LENGTH ? { status: 'idle' } : state;
}

export function FileSearchInput({
  value,
  onChange,
  inputRef,
  onLeave,
}: {
  value: string;
  onChange: (value: string) => void;
  inputRef: Ref<HTMLInputElement>;
  onLeave: (direction: 'back' | 'down') => void;
}): ReactElement {
  return (
    <Input
      ref={inputRef}
      size="md"
      type="text"
      role="searchbox"
      enterKeyHint="search"
      className="files-search"
      aria-label="Search files"
      placeholder="Search files"
      value={value}
      autoComplete="off"
      spellCheck={false}
      leading={<MagnifyingGlass size={16} aria-hidden="true" />}
      trailing={
        value ? (
          <IconButton size="sm" label="Clear search" icon={X} onClick={() => onChange('')} />
        ) : undefined
      }
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          if (value) onChange('');
          else onLeave('back');
        }
        if (event.key === 'ArrowDown') {
          event.preventDefault();
          onLeave('down');
        }
      }}
    />
  );
}

export function FileSearchResults({
  query,
  search,
  onOpen,
  listRef,
}: {
  query: string;
  search: FileSearchState;
  onOpen: (path: string) => void;
  listRef?: Ref<HTMLUListElement>;
}): ReactElement {
  const own = useRef<HTMLUListElement | null>(null);

  if (search.status === 'idle') {
    return (
      <p className="files-search__hint" role="status">
        Type at least {SEARCH_MIN_LENGTH} characters to search.
      </p>
    );
  }

  if (search.status === 'loading') {
    return (
      <div className="files-search__results" aria-busy="true" aria-label="Searching">
        {[70, 55, 80].map((width) => (
          <Skeleton
            key={width}
            shape="row"
            width={`${width}%`}
            className="files-search__skeleton"
          />
        ))}
      </div>
    );
  }

  if (search.status === 'error') {
    return (
      <Callout
        tone="danger"
        className="files-callout"
        title={search.message}
        action={
          <Button size="sm" onClick={search.retry}>
            Retry
          </Button>
        }
      />
    );
  }

  if (search.results.length === 0) {
    return (
      <EmptyState
        icon={MagnifyingGlass}
        title={`No matches for "${query.trim()}"`}
        body="Search looks at file names and at the text inside files."
      />
    );
  }

  const moveFocus = (from: HTMLElement, step: 1 | -1): void => {
    const buttons = Array.from(
      own.current?.querySelectorAll<HTMLButtonElement>('.files-result') ?? [],
    );
    buttons[buttons.indexOf(from as HTMLButtonElement) + step]?.focus();
  };

  return (
    <div className="files-search__results">
      <p className="files-search__count" role="status">
        {search.truncated
          ? `First ${formatCount(search.results.length, 'match', 'matches')}. Add to the search to narrow it.`
          : formatCount(search.results.length, 'match', 'matches')}
      </p>
      <ul
        className="files-search__list"
        aria-label="Search results"
        ref={(element) => {
          own.current = element;
          if (typeof listRef === 'function') listRef(element);
          else if (listRef) listRef.current = element;
        }}
      >
        {search.results.map((result) => {
          const name = result.path.split('/').pop() ?? result.path;
          const folder = parentOf(result.path);
          return (
            <li key={`${result.path}:${result.lineNumber ?? 0}`}>
              <button
                type="button"
                className="files-result"
                onClick={() => onOpen(result.path)}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowDown') {
                    event.preventDefault();
                    moveFocus(event.currentTarget, 1);
                  }
                  if (event.key === 'ArrowUp') {
                    event.preventDefault();
                    moveFocus(event.currentTarget, -1);
                  }
                }}
              >
                <span className="files-result__name">{name}</span>
                {folder ? <span className="files-result__folder">{folder}/</span> : null}
                {result.match === 'content' && result.line ? (
                  <span className="files-result__line">
                    {result.lineNumber ? (
                      <span className="files-result__number">{result.lineNumber}</span>
                    ) : null}
                    {result.line}
                  </span>
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
