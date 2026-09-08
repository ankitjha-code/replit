import { useRef, type DragEvent, type KeyboardEvent } from 'react';
import { languageOf, parentOf, type FileEntry } from '@platform/shared';
import { flattenVisible, type TreeNode } from './build-tree.js';

export interface FileTreeProps {
  roots: readonly TreeNode[];
  expanded: ReadonlySet<string>;
  selected: string | undefined;
  /** Path currently being renamed, if any. */
  renaming: string | undefined;
  canWrite: boolean;
  onToggle: (path: string) => void;
  onSelect: (entry: FileEntry) => void;
  onRenameStart: (path: string) => void;
  onRenameSubmit: (path: string, name: string) => void;
  onRenameCancel: () => void;
  onMove: (from: string, to: string) => void;
  onDelete: (path: string) => void;
}

/**
 * The project tree.
 *
 * A real ARIA tree rather than a list of buttons: assistive technology
 * announces depth and expansion, and the arrow keys behave the way they do in
 * every other tree. Only one row is in the tab order, so tabbing past the
 * explorer takes one press rather than one per file.
 */
export function FileTree(props: FileTreeProps): React.JSX.Element {
  const { roots, expanded, selected } = props;
  const rows = flattenVisible(roots, expanded);
  const containerRef = useRef<HTMLDivElement>(null);

  const focusRow = (index: number): void => {
    const clamped = Math.max(0, Math.min(rows.length - 1, index));
    const target =
      containerRef.current?.querySelectorAll<HTMLElement>('[role="treeitem"]')[clamped];
    target?.focus();
  };

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
        const parent = parentOf(entry.path);
        const parentIndex = rows.findIndex((candidate) => candidate.node.entry.path === parent);
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
        if (props.canWrite) {
          event.preventDefault();
          props.onRenameStart(entry.path);
        }
        break;
      case 'Delete':
        if (props.canWrite) {
          event.preventDefault();
          props.onDelete(entry.path);
        }
        break;
      default:
        break;
    }
  };

  if (rows.length === 0) return <></>;

  return (
    <div className="file-tree" role="tree" aria-label="Project files" ref={containerRef}>
      {rows.map((row, index) => (
        <Row
          key={row.node.entry.path}
          node={row.node}
          depth={row.depth}
          index={index}
          // Roving tab index: the selected row, or the first one, is the only
          // stop between the explorer and whatever follows it.
          tabbable={selected === row.node.entry.path || (selected === undefined && index === 0)}
          {...props}
          onKeyDown={onKeyDown}
        />
      ))}
    </div>
  );
}

interface RowProps extends FileTreeProps {
  node: TreeNode;
  depth: number;
  index: number;
  tabbable: boolean;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>, index: number) => void;
}

function Row(props: RowProps): React.JSX.Element {
  const { node, depth, expanded, selected, renaming, canWrite } = props;
  const { entry } = node;
  const isDirectory = entry.type === 'DIRECTORY';
  const isOpen = isDirectory && expanded.has(entry.path);

  const onDragStart = (event: DragEvent<HTMLDivElement>): void => {
    event.dataTransfer.setData('text/plain', entry.path);
    event.dataTransfer.effectAllowed = 'move';
  };

  const onDragOver = (event: DragEvent<HTMLDivElement>): void => {
    if (!canWrite || !isDirectory) return;
    // Preventing the default is what marks an element as a drop target.
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  };

  const onDrop = (event: DragEvent<HTMLDivElement>): void => {
    if (!canWrite || !isDirectory) return;
    event.preventDefault();
    event.stopPropagation();

    const from = event.dataTransfer.getData('text/plain');
    if (from && from !== entry.path) props.onMove(from, entry.path);
  };

  return (
    <div
      role="treeitem"
      aria-level={depth + 1}
      aria-selected={selected === entry.path}
      {...(isDirectory ? { 'aria-expanded': isOpen } : {})}
      tabIndex={props.tabbable ? 0 : -1}
      className={`file-row${selected === entry.path ? ' file-row--selected' : ''}`}
      style={{ paddingLeft: `${depth * 12 + 8}px` }}
      onClick={() => (isDirectory ? props.onToggle(entry.path) : props.onSelect(entry))}
      onKeyDown={(event) => props.onKeyDown(event, props.index)}
      onDoubleClick={() => canWrite && props.onRenameStart(entry.path)}
      draggable={canWrite && renaming !== entry.path}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      data-path={entry.path}
    >
      <span className="file-row__twisty" aria-hidden="true">
        {isDirectory ? (isOpen ? '▾' : '▸') : ''}
      </span>
      <span className={`file-row__icon file-row__icon--${iconFor(entry)}`} aria-hidden="true" />

      {renaming === entry.path ? (
        <RenameInput
          initial={entry.name}
          onSubmit={(name) => props.onRenameSubmit(entry.path, name)}
          onCancel={props.onRenameCancel}
        />
      ) : (
        <span className="file-row__name">{entry.name}</span>
      )}
    </div>
  );
}

function RenameInput({
  initial,
  onSubmit,
  onCancel,
}: {
  initial: string;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}): React.JSX.Element {
  return (
    <input
      className="file-row__input"
      defaultValue={initial}
      autoFocus
      aria-label="New name"
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Enter') onSubmit((event.target as HTMLInputElement).value);
        if (event.key === 'Escape') onCancel();
      }}
      // Clicking away commits, which is what an inline rename does elsewhere.
      onBlur={(event) => onSubmit(event.target.value)}
    />
  );
}

/**
 * A coarse icon class from the file's language.
 *
 * Derived from the shared type detection so the explorer, the editor and the
 * preview agree about what a file is.
 */
function iconFor(entry: FileEntry): string {
  if (entry.type === 'DIRECTORY') return 'folder';
  if (entry.isBinary) return 'binary';
  return languageOf(entry.path);
}
