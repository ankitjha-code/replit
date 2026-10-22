import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { Dialog as DialogPrimitive, VisuallyHidden } from 'radix-ui';
import { Button } from '../Button/Button.js';
import { Callout } from '../Callout/Callout.js';
import { Kbd } from '../Kbd/Kbd.js';
import { Skeleton } from '../Skeleton/Skeleton.js';
import { FileCode, MagnifyingGlass } from '../icons.js';
import { cx } from '../internal/cx.js';
import { portalRoot } from '../internal/portal.js';
import { renderIcon, type IconLike } from '../internal/types.js';
import { rank } from './match.js';
import './CommandPalette.css';

export interface PaletteCommand {
  id: string;
  label: string;
  icon?: IconLike;
  shortcut?: string[];
  /** A heading the command is listed under ("Environment", "Panels"). */
  group?: string;
  /** Extra words the search should hit. */
  keywords?: string[];
  onSelect: () => void;
  disabledReason?: string;
}

export interface PaletteFile {
  path: string;
}

export interface PaletteFiles {
  status: 'idle' | 'loading' | 'ready' | 'error';
  items: PaletteFile[];
  error?: string;
  retry?: () => void;
}

export interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  commands: PaletteCommand[];
  /** Ids of recently run commands, listed first while the query is empty. */
  recent?: string[];
  /** Where the palette starts: commands (Ctrl+K) or files (Ctrl+P). */
  mode?: 'commands' | 'files';
  /** File search results for the current file query; the palette asks for them through `onFileQuery`. */
  files?: PaletteFiles;
  onFileQuery?: (query: string) => void;
  onOpenFile?: (path: string) => void;
  /** Offers "Create {name}" when no file matches. */
  onCreateFile?: (name: string) => void;
  placeholder?: string;
}

const FILES_PREFIX = '>';
const RECENT_LIMIT = 5;

interface Row {
  id: string;
  label: string;
  icon?: IconLike | undefined;
  shortcut?: string[] | undefined;
  group: string;
  disabledReason?: string | undefined;
  onSelect: () => void;
}

/**
 * A Dialog plus an own filtered list: Ctrl/Cmd+K opens commands, `>` switches
 * to files, arrows move, Enter runs, Esc closes. The input owns focus and
 * points at the active row with aria-activedescendant.
 */
export function CommandPalette({
  open,
  onOpenChange,
  commands,
  recent = [],
  mode = 'commands',
  files,
  onFileQuery,
  onOpenFile,
  onCreateFile,
  placeholder = 'Type a command, or > to open a file',
}: CommandPaletteProps): ReactElement {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  // Every opening starts from the requested mode with nothing typed.
  useEffect(() => {
    if (open) {
      setQuery(mode === 'files' ? FILES_PREFIX : '');
      setActive(0);
    }
  }, [open, mode]);

  const filesMode = query.startsWith(FILES_PREFIX);
  const fileQuery = filesMode ? query.slice(FILES_PREFIX.length).trim() : '';

  useEffect(() => {
    if (open && filesMode) onFileQuery?.(fileQuery);
  }, [open, filesMode, fileQuery, onFileQuery]);

  const rows = useMemo<Row[]>(() => {
    if (filesMode) {
      const items = files?.items ?? [];
      const ranked = fileQuery
        ? rank(items, fileQuery, (file) => file.path)
        : items.map((item) => ({ item, score: 0 }));
      return ranked.map(({ item }) => ({
        id: `file:${item.path}`,
        label: item.path,
        icon: FileCode,
        group: 'Files',
        onSelect: () => onOpenFile?.(item.path),
      }));
    }
    const toRow = (command: PaletteCommand, group = command.group ?? 'Commands'): Row => ({
      id: command.id,
      label: command.label,
      icon: command.icon,
      shortcut: command.shortcut,
      group,
      disabledReason: command.disabledReason,
      onSelect: command.onSelect,
    });
    if (!query.trim()) {
      const recentRows = recent
        .slice(0, RECENT_LIMIT)
        .map((id) => commands.find((command) => command.id === id))
        .filter((command): command is PaletteCommand => Boolean(command))
        .map((command) => toRow(command, 'Recent'));
      const recentIds = new Set(recentRows.map((row) => row.id));
      return [
        ...recentRows,
        ...commands
          .filter((command) => !recentIds.has(command.id))
          .map((command) => toRow(command)),
      ];
    }
    return rank(commands, query, (command) =>
      [command.label, ...(command.keywords ?? [])].join(' '),
    ).map(({ item }) => toRow(item));
  }, [commands, fileQuery, files?.items, filesMode, onOpenFile, query, recent]);

  useEffect(() => {
    setActive(0);
  }, [query]);

  useEffect(() => {
    const element = listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    element?.scrollIntoView({ block: 'nearest' });
  }, [active, rows.length]);

  const select = (row: Row): void => {
    if (row.disabledReason) return;
    onOpenChange(false);
    row.onSelect();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((current) => (rows.length ? (current + 1) % rows.length : 0));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((current) => (rows.length ? (current - 1 + rows.length) % rows.length : 0));
    } else if (event.key === 'Home') {
      event.preventDefault();
      setActive(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      setActive(Math.max(0, rows.length - 1));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const row = rows[active];
      if (row) select(row);
      else if (filesMode && fileQuery && onCreateFile) {
        onOpenChange(false);
        onCreateFile(fileQuery);
      }
    }
  };

  const activeId = rows[active] ? `${listId}-${active}` : undefined;
  const loadingFiles = filesMode && files?.status === 'loading';
  const filesError = filesMode && files?.status === 'error';

  let body: ReactNode;
  if (loadingFiles && rows.length === 0) {
    body = (
      <div className="ui-palette__state" aria-busy="true">
        <Skeleton lines={4} />
      </div>
    );
  } else if (filesError) {
    body = (
      <div className="ui-palette__state">
        <Callout
          tone="danger"
          title={files?.error ?? 'Could not search files'}
          action={
            files?.retry ? (
              <Button size="sm" onClick={files.retry}>
                Retry
              </Button>
            ) : undefined
          }
        />
      </div>
    );
  } else if (rows.length === 0) {
    body = (
      <div className="ui-palette__empty" role="status">
        <MagnifyingGlass size={20} aria-hidden="true" />
        <p>
          {filesMode
            ? fileQuery
              ? `No files match "${fileQuery}".`
              : 'Type a file name.'
            : 'No commands match.'}
        </p>
        {filesMode && fileQuery && onCreateFile ? (
          <Button
            size="sm"
            onClick={() => {
              onOpenChange(false);
              onCreateFile(fileQuery);
            }}
          >
            Create "{fileQuery}"
          </Button>
        ) : null}
      </div>
    );
  } else {
    let lastGroup: string | undefined;
    body = (
      <ul
        ref={listRef}
        id={listId}
        className="ui-palette__list"
        role="listbox"
        aria-label={filesMode ? 'Files' : 'Commands'}
      >
        {rows.map((row, index) => {
          const heading = row.group !== lastGroup ? row.group : undefined;
          lastGroup = row.group;
          return (
            <li key={row.id} role="presentation" className="ui-palette__entry">
              {heading ? (
                <div className="ui-palette__heading" role="presentation">
                  {heading}
                </div>
              ) : null}
              <div
                id={`${listId}-${index}`}
                role="option"
                aria-selected={index === active}
                aria-disabled={row.disabledReason ? true : undefined}
                data-index={index}
                className={cx(
                  'ui-palette__option',
                  index === active && 'ui-palette__option--active',
                  row.disabledReason && 'ui-palette__option--disabled',
                )}
                onMouseMove={() => setActive(index)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => select(row)}
              >
                <span className="ui-palette__icon">{renderIcon(row.icon)}</span>
                <span className="ui-palette__text">
                  <span className="ui-palette__label">{row.label}</span>
                  {row.disabledReason ? (
                    <span className="ui-palette__reason">{row.disabledReason}</span>
                  ) : null}
                </span>
                {row.shortcut ? <Kbd keys={row.shortcut} /> : null}
              </div>
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal container={portalRoot()}>
        <DialogPrimitive.Overlay className="ui-dialog__overlay" data-ui-portal="dialog" />
        <DialogPrimitive.Content
          className="ui-palette"
          data-ui-portal="dialog"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            inputRef.current?.focus();
          }}
        >
          <VisuallyHidden.Root>
            <DialogPrimitive.Title>Command palette</DialogPrimitive.Title>
            <DialogPrimitive.Description>
              Type to filter. Use the arrow keys to choose and Enter to run.
            </DialogPrimitive.Description>
          </VisuallyHidden.Root>
          <div className="ui-palette__input-row">
            <MagnifyingGlass size={16} className="ui-palette__search-icon" aria-hidden="true" />
            <input
              ref={inputRef}
              className="ui-palette__input"
              type="text"
              role="combobox"
              aria-expanded="true"
              aria-controls={listId}
              aria-activedescendant={activeId}
              aria-autocomplete="list"
              aria-label={filesMode ? 'Search files' : 'Search commands'}
              autoComplete="off"
              spellCheck={false}
              placeholder={placeholder}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={onKeyDown}
            />
            {loadingFiles ? (
              <Skeleton width={48} height={12} className="ui-palette__loading" />
            ) : null}
          </div>
          {body}
          <div className="ui-palette__hint" aria-hidden="true">
            <Kbd keys={['ArrowUp']} /> <Kbd keys={['ArrowDown']} /> to choose,{' '}
            <Kbd keys={['Enter']} /> to run, <Kbd keys={['Escape']} /> to close
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
