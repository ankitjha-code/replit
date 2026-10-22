import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type KeyboardEvent,
  type ReactElement,
  type SyntheticEvent,
} from 'react';
import { extensionOf, parentOf, type FileEntry } from '@platform/shared';
import { IconButton, Menu, Spinner, type MenuGroup } from '../../ui/index.js';
import {
  CaretRight,
  DotsThree,
  File,
  FileCode,
  FileCss,
  FileHtml,
  FileJs,
  FileMd,
  FilePy,
  FileText,
  FileTs,
  FolderOpen,
  FolderSimple,
  Image,
  type Icon,
} from '../../ui/icons.js';
import { flattenVisible, type TreeNode } from './build-tree.js';

export interface FileTreeProps {
  roots: readonly TreeNode[];
  expanded: ReadonlySet<string>;
  selected: string | undefined;
  /** Path currently being renamed, if any. */
  renaming: string | undefined;
  canWrite: boolean;
  /** Paths with an operation in flight: a spinner, `aria-busy`, no second submit. */
  busy?: ReadonlySet<string>;
  onToggle: (path: string) => void;
  onSelect: (entry: FileEntry) => void;
  onRenameStart: (path: string) => void;
  onRenameSubmit: (path: string, name: string) => void;
  onRenameCancel: () => void;
  /** Moves `from` into the folder `to` ('' is the project root). */
  onMove: (from: string, to: string) => void;
  onDelete: (path: string) => void;
  /** Files dragged in from the device; read the DataTransfer before awaiting anything. */
  onDropFiles?: (data: DataTransfer, directory: string) => void;
  /** The row overflow menu: the same items as the context menu. */
  menuGroups?: (entry: FileEntry) => MenuGroup[];
  /** The row menu is closing; prevent it to keep focus where an item put it. */
  onMenuCloseAutoFocus?: (event: Event) => void;
}

interface DropTarget {
  /** '' is the project root. */
  directory: string;
  kind: 'move' | 'upload';
}

/**
 * The project tree.
 *
 * A real ARIA tree rather than a list of buttons: assistive technology
 * announces depth and expansion, and the arrow keys behave the way they do in
 * every other tree. Only one row is in the tab order, so tabbing past the
 * explorer takes one press rather than one per file.
 */
export function FileTree(props: FileTreeProps): ReactElement {
  const { roots, expanded, selected, canWrite } = props;
  const rows = flattenVisible(roots, expanded);
  const containerRef = useRef<HTMLDivElement>(null);

  // The row that last had focus, so Tab comes back to where the person was.
  const [focused, setFocused] = useState<string | undefined>();
  const focusedIndex = useRef(0);
  const hasFocus = useRef(false);

  /*
   * The one row in the tab order. Falls back to the first row whenever the
   * remembered one is not on screen (collapsed away, renamed, deleted), so
   * the tree can always be reached with Tab. The old rule tied it to the
   * selected file only, and a selected file inside a closed folder left no
   * row reachable at all.
   */
  const indexOf = (path: string | undefined): number =>
    path === undefined ? -1 : rows.findIndex((row) => row.node.entry.path === path);
  const tabbable = ((): number => {
    if (indexOf(focused) >= 0) return indexOf(focused);
    // The focused row went away: its neighbour now sits at the same place.
    if (focused !== undefined) return Math.min(focusedIndex.current, rows.length - 1);
    return Math.max(0, indexOf(selected));
  })();

  const focusRow = (index: number): void => {
    const clamped = Math.max(0, Math.min(rows.length - 1, index));
    const target =
      containerRef.current?.querySelectorAll<HTMLElement>('[role="treeitem"]')[clamped];
    target?.focus();
  };

  /*
   * When the focused row disappears (deleted, moved, the tree reloaded under
   * it), focus would fall to the page. Put it back on the nearest row so the
   * keyboard keeps its place in the tree.
   */
  const rowKey = rows.map((row) => row.node.entry.path).join('\n');
  useLayoutEffect(() => {
    if (!hasFocus.current || rows.length === 0) return;
    const active = document.activeElement;
    if (active && active !== document.body && document.contains(active)) return;
    focusRow(tabbable);
    // Only when the set of rows changes, not on every render.
  }, [rowKey]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>, index: number): void => {
    const row = rows[index];
    if (!row) return;

    const { entry } = row.node;
    const isOpenDirectory = entry.type === 'DIRECTORY' && expanded.has(entry.path);

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        focusRow(index + 1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        focusRow(index - 1);
        break;
      case 'Home':
        event.preventDefault();
        focusRow(0);
        break;
      case 'End':
        event.preventDefault();
        focusRow(rows.length - 1);
        break;
      case 'ArrowRight':
        event.preventDefault();
        // Open a closed directory; step into an open one. Same key, two
        // meanings, which is the convention everywhere.
        if (entry.type === 'DIRECTORY' && !isOpenDirectory) props.onToggle(entry.path);
        else if (isOpenDirectory) focusRow(index + 1);
        break;
      case 'ArrowLeft': {
        event.preventDefault();
        if (isOpenDirectory) {
          props.onToggle(entry.path);
          break;
        }
        // Otherwise move to the containing folder, which is where "out" goes.
        const parentIndex = indexOf(parentOf(entry.path));
        if (parentIndex >= 0) focusRow(parentIndex);
        break;
      }
      case 'Enter':
      case ' ':
        event.preventDefault();
        if (entry.type === 'DIRECTORY') props.onToggle(entry.path);
        else props.onSelect(entry);
        break;
      case 'F2':
        if (canWrite) {
          event.preventDefault();
          props.onRenameStart(entry.path);
        }
        break;
      case 'Delete':
        if (canWrite) {
          event.preventDefault();
          props.onDelete(entry.path);
        }
        break;
      case 'ContextMenu':
      case 'F10':
        if (event.key === 'F10' && !event.shiftKey) break;
        // Not every browser turns these keys into a contextmenu event (macOS
        // has no such convention), so the row raises one itself, placed under
        // the row's name where a pointer would have put the menu.
        event.preventDefault();
        openContextMenuAt(event.currentTarget);
        break;
      default:
        break;
    }
  };

  // --- drag and drop -------------------------------------------------------

  const dragging = useRef<string | undefined>(undefined);
  const [drop, setDrop] = useState<DropTarget | undefined>();

  /** The folder a drop at this element lands in: the row's folder, or the root. */
  const directoryAt = (target: EventTarget | null): string => {
    const row = target instanceof Element ? target.closest<HTMLElement>('[data-path]') : null;
    if (!row || !containerRef.current?.contains(row)) return '';
    const path = row.dataset.path ?? '';
    return row.dataset.type === 'DIRECTORY' ? path : parentOf(path);
  };

  const onDragOver = (event: DragEvent<HTMLDivElement>): void => {
    if (!canWrite) return;
    const directory = directoryAt(event.target);

    if (isFileDrag(event.dataTransfer)) {
      if (!props.onDropFiles) return;
      // Not stopped: the panel's drop zone sees it is handled and stays quiet.
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
      setDrop((current) => same(current, directory, 'upload') ?? { directory, kind: 'upload' });
      return;
    }

    const from = dragging.current;
    if (from === undefined) return;
    if (!canMoveInto(from, directory)) {
      // Not preventing the default is what shows the not-allowed cursor.
      event.dataTransfer.dropEffect = 'none';
      setDrop(undefined);
      return;
    }
    // Preventing the default is what marks an element as a drop target.
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    setDrop((current) => same(current, directory, 'move') ?? { directory, kind: 'move' });
  };

  const onDrop = (event: DragEvent<HTMLDivElement>): void => {
    setDrop(undefined);
    if (!canWrite) return;
    const directory = directoryAt(event.target);

    if (isFileDrag(event.dataTransfer)) {
      if (!props.onDropFiles) return;
      event.preventDefault();
      event.stopPropagation();
      props.onDropFiles(event.dataTransfer, directory);
      return;
    }

    const from = event.dataTransfer.getData('text/plain') || dragging.current;
    dragging.current = undefined;
    if (!from || !canMoveInto(from, directory)) return;
    event.preventDefault();
    event.stopPropagation();
    props.onMove(from, directory);
  };

  const onDragLeave = (event: DragEvent<HTMLDivElement>): void => {
    const next = event.relatedTarget;
    if (!(next instanceof Node) || !containerRef.current?.contains(next)) setDrop(undefined);
  };

  const onDragStart = (event: DragEvent<HTMLDivElement>, entry: FileEntry): void => {
    dragging.current = entry.path;
    event.dataTransfer.setData('text/plain', entry.path);
    event.dataTransfer.effectAllowed = 'move';
    showDragGhost(event.dataTransfer, entry.name);
  };

  const onDragEnd = (): void => {
    dragging.current = undefined;
    setDrop(undefined);
  };

  if (rows.length === 0) return <></>;

  const rootDrop = drop?.directory === '';

  return (
    <div
      className={`files-tree${rootDrop ? ' files-tree--drop' : ''}`}
      role="tree"
      aria-label="Project files"
      ref={containerRef}
      data-drop-label={rootDrop ? dropLabel(drop) : undefined}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragLeave={onDragLeave}
      onFocus={() => {
        hasFocus.current = true;
      }}
      onBlur={(event) => {
        const next = event.relatedTarget;
        if (next instanceof Node && containerRef.current?.contains(next)) return;
        // Leaving for a menu or a dialog that will hand focus back still
        // counts as being in the tree; only a real move elsewhere clears it.
        if (next instanceof Element && next.closest('[data-ui-portal]')) return;
        if (next instanceof Node) hasFocus.current = false;
      }}
    >
      {rows.map((row, index) => (
        <Row
          key={row.node.entry.path}
          node={row.node}
          depth={row.depth}
          tabbable={index === tabbable}
          isOpen={row.node.entry.type === 'DIRECTORY' && expanded.has(row.node.entry.path)}
          isSelected={selected === row.node.entry.path}
          isRenaming={props.renaming === row.node.entry.path}
          isBusy={props.busy?.has(row.node.entry.path) ?? false}
          dropLabel={
            drop && drop.directory !== '' && drop.directory === row.node.entry.path
              ? dropLabel(drop)
              : undefined
          }
          canWrite={canWrite}
          menuGroups={props.menuGroups}
          onMenuCloseAutoFocus={props.onMenuCloseAutoFocus}
          onFocus={() => {
            focusedIndex.current = index;
            setFocused(row.node.entry.path);
          }}
          onKeyDown={(event) => onKeyDown(event, index)}
          onToggle={props.onToggle}
          onSelect={props.onSelect}
          onRenameStart={props.onRenameStart}
          onRenameSubmit={props.onRenameSubmit}
          onRenameCancel={props.onRenameCancel}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
        />
      ))}
    </div>
  );
}

interface RowProps {
  node: TreeNode;
  depth: number;
  tabbable: boolean;
  isOpen: boolean;
  isSelected: boolean;
  isRenaming: boolean;
  isBusy: boolean;
  dropLabel: string | undefined;
  canWrite: boolean;
  menuGroups: ((entry: FileEntry) => MenuGroup[]) | undefined;
  onMenuCloseAutoFocus: ((event: Event) => void) | undefined;
  onFocus: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  onToggle: (path: string) => void;
  onSelect: (entry: FileEntry) => void;
  onRenameStart: (path: string) => void;
  onRenameSubmit: (path: string, name: string) => void;
  onRenameCancel: () => void;
  onDragStart: (event: DragEvent<HTMLDivElement>, entry: FileEntry) => void;
  onDragEnd: () => void;
}

/** Keeps a click or key on a control inside a row from also acting on the row. */
const stop = (event: SyntheticEvent): void => event.stopPropagation();

function Row(props: RowProps): ReactElement {
  const { node, depth, isOpen, isSelected, isRenaming, isBusy, canWrite } = props;
  const { entry } = node;
  const isDirectory = entry.type === 'DIRECTORY';
  const RowIcon = iconFor(entry, isOpen);

  const className = [
    'files-row',
    isSelected && 'files-row--selected',
    props.dropLabel && 'files-row--drop',
    isBusy && 'files-row--busy',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      role="treeitem"
      // The name alone: the overflow button inside the row is not part of it.
      aria-label={entry.name}
      aria-level={depth + 1}
      aria-selected={isSelected}
      {...(isDirectory ? { 'aria-expanded': isOpen } : {})}
      {...(isBusy ? { 'aria-busy': true } : {})}
      tabIndex={props.tabbable ? 0 : -1}
      className={className}
      style={{ '--files-depth': depth } as CSSProperties}
      onFocus={(event) => {
        if (event.target === event.currentTarget) props.onFocus();
      }}
      onClick={() => (isDirectory ? props.onToggle(entry.path) : props.onSelect(entry))}
      onKeyDown={props.onKeyDown}
      onDoubleClick={() => canWrite && !isBusy && props.onRenameStart(entry.path)}
      draggable={canWrite && !isRenaming && !isBusy}
      onDragStart={(event) => props.onDragStart(event, entry)}
      onDragEnd={props.onDragEnd}
      data-path={entry.path}
      data-type={entry.type}
      data-drop-label={props.dropLabel}
    >
      <span className="files-row__caret" aria-hidden="true">
        {isDirectory ? <CaretRight size={12} weight="bold" /> : null}
      </span>
      <span className="files-row__icon" aria-hidden="true">
        {isBusy ? <Spinner size={12} aria-hidden /> : <RowIcon size={16} />}
      </span>

      {isRenaming ? (
        <InlineNameInput
          initial={entry.name}
          label="New name"
          className="files-row__input"
          onSubmit={(name) => props.onRenameSubmit(entry.path, name)}
          onCancel={props.onRenameCancel}
        />
      ) : (
        <span className="files-row__name">{entry.name}</span>
      )}

      {props.menuGroups && !isRenaming ? (
        <span className="files-row__more" onClick={stop} onDoubleClick={stop} onKeyDown={stop}>
          <Menu
            align="start"
            label={`Actions for ${entry.name}`}
            groups={props.menuGroups(entry)}
            {...(props.onMenuCloseAutoFocus
              ? { onCloseAutoFocus: props.onMenuCloseAutoFocus }
              : {})}
            trigger={
              <IconButton
                size="sm"
                label={`Actions for ${entry.name}`}
                icon={DotsThree}
                // Keyboard users reach the same items with Shift+F10 or the
                // Menu key; one tab stop for the whole tree is the point.
                tabIndex={-1}
                draggable={false}
              />
            }
          />
        </span>
      ) : null}
    </div>
  );
}

/** How long a blurred field waits before treating the blur as "done". */
export const BLUR_COMMIT_MS = 150;

/**
 * The inline name field, for renames and for new entries.
 *
 * Enter commits, Escape cancels. Clicking away commits too, which is what an
 * inline rename does elsewhere, but only after a short wait and only if focus
 * has not come back: a toast or a closing menu that takes focus for a moment
 * must not submit a half-typed name. An empty name is a cancel, never a
 * commit.
 */
export function InlineNameInput({
  initial = '',
  label,
  placeholder,
  className,
  onSubmit,
  onCancel,
}: {
  initial?: string;
  label: string;
  placeholder?: string;
  className?: string;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}): ReactElement {
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    const input = ref.current;
    if (input) {
      input.focus();
      // Select the name without its extension, the part people usually change.
      const dot = initial.lastIndexOf('.');
      input.setSelectionRange(0, dot > 0 ? dot : initial.length);
    }
    return () => clearTimeout(timer.current);
  }, [initial]);

  const finish = (commit: boolean): void => {
    if (done.current) return;
    clearTimeout(timer.current);
    const value = ref.current?.value ?? '';
    done.current = true;
    if (commit && value.trim().length > 0) onSubmit(value);
    else onCancel();
  };

  return (
    <input
      ref={ref}
      className={className}
      defaultValue={initial}
      placeholder={placeholder}
      aria-label={label}
      autoComplete="off"
      spellCheck={false}
      onClick={stop}
      onDoubleClick={stop}
      onFocus={() => clearTimeout(timer.current)}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Enter') {
          event.preventDefault();
          // Enter on an empty field is "never mind" for a new entry; for a
          // rename the caller treats it as unchanged.
          if ((ref.current?.value ?? '').trim().length === 0) finish(false);
          else finish(true);
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          finish(false);
        }
      }}
      onBlur={() => {
        clearTimeout(timer.current);
        timer.current = setTimeout(() => {
          if (document.activeElement === ref.current) return;
          finish(true);
        }, BLUR_COMMIT_MS);
      }}
    />
  );
}

function openContextMenuAt(row: HTMLElement): void {
  const box = row.getBoundingClientRect();
  row.dispatchEvent(
    new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: box.left + 32,
      clientY: box.bottom,
    }),
  );
}

function isFileDrag(data: DataTransfer | null): boolean {
  return Array.from(data?.types ?? []).includes('Files');
}

/** A folder cannot go into itself, into something inside it, or where it already is. */
export function canMoveInto(from: string, directory: string): boolean {
  if (directory === from || directory.startsWith(`${from}/`)) return false;
  return parentOf(from) !== directory;
}

function same(
  current: DropTarget | undefined,
  directory: string,
  kind: DropTarget['kind'],
): DropTarget | undefined {
  return current && current.directory === directory && current.kind === kind ? current : undefined;
}

function dropLabel(drop: DropTarget): string {
  const where = drop.directory === '' ? 'the project root' : `${drop.directory}/`;
  return drop.kind === 'upload' ? `Upload to ${where}` : `Move to ${where}`;
}

/**
 * The drag image: the entry's name in a small chip rather than a screenshot
 * of the whole row, which is wide and mostly empty.
 */
function showDragGhost(data: DataTransfer, name: string): void {
  if (typeof data.setDragImage !== 'function') return;
  const ghost = document.createElement('div');
  ghost.className = 'files-drag-ghost';
  ghost.textContent = name;
  document.body.appendChild(ghost);
  data.setDragImage(ghost, -12, -8);
  // The browser copies the image during this event; the element can go.
  setTimeout(() => ghost.remove(), 0);
}

const ICONS_BY_EXTENSION: Readonly<Record<string, Icon>> = {
  js: FileJs,
  mjs: FileJs,
  cjs: FileJs,
  jsx: FileJs,
  ts: FileTs,
  tsx: FileTs,
  mts: FileTs,
  py: FilePy,
  html: FileHtml,
  htm: FileHtml,
  css: FileCss,
  md: FileMd,
  markdown: FileMd,
  png: Image,
  jpg: Image,
  jpeg: Image,
  gif: Image,
  svg: Image,
  webp: Image,
  ico: Image,
  txt: FileText,
  json: FileCode,
  yaml: FileCode,
  yml: FileCode,
  toml: FileCode,
  rb: FileCode,
  go: FileCode,
  rs: FileCode,
  java: FileCode,
  c: FileCode,
  h: FileCode,
  cpp: FileCode,
  sh: FileCode,
  php: FileCode,
};

/** One muted glyph per kind of file; colour stays reserved for meaning. */
function iconFor(entry: FileEntry, isOpen: boolean): Icon {
  if (entry.type === 'DIRECTORY') return isOpen ? FolderOpen : FolderSimple;
  return ICONS_BY_EXTENSION[extensionOf(entry.path)] ?? File;
}
