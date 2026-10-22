import { useState, type MouseEvent, type ReactElement, type ReactNode } from 'react';
import { parentOf, type FileEntry } from '@platform/shared';
import { ContextMenu, type MenuGroup } from '../../ui/index.js';
import {
  Copy,
  DownloadSimple,
  FilePlus,
  FolderPlus,
  PencilSimple,
  Trash,
  UploadSimple,
} from '../../ui/icons.js';

/** What the menus can do; the panel supplies the work. */
export interface FileMenuActions {
  newFile: (directory: string) => void;
  newFolder: (directory: string) => void;
  upload: (directory: string) => void;
  rename: (path: string) => void;
  duplicate: (path: string) => void;
  move: (path: string) => void;
  copyPath: (path: string) => void;
  download: (path: string) => void;
  remove: (path: string) => void;
}

const READ_ONLY = 'You have read-only access to this project.';

/**
 * The items for one entry, or for the empty area when `entry` is undefined
 * (design spec 9.4). The row's context menu and its overflow button show the
 * same list, so a touch screen loses nothing.
 *
 * Items that do not apply to a folder (Duplicate, Download) are left out
 * rather than disabled: they are not unavailable, they are not things a
 * folder does. Items a viewer may not use are left out too, except on the
 * empty area, where an empty menu would say nothing at all.
 */
export function fileMenuGroups(
  entry: FileEntry | undefined,
  canWrite: boolean,
  actions: FileMenuActions,
): MenuGroup[] {
  const isFolder = entry?.type === 'DIRECTORY';
  const directory = entry === undefined ? '' : isFolder ? entry.path : parentOf(entry.path);
  const here = entry === undefined ? '' : ' here';

  const create: MenuGroup = {
    items: [
      {
        id: 'new-file',
        label: `New file${here}`,
        icon: FilePlus,
        onSelect: () => actions.newFile(directory),
      },
      {
        id: 'new-folder',
        label: `New folder${here}`,
        icon: FolderPlus,
        onSelect: () => actions.newFolder(directory),
      },
      {
        id: 'upload',
        label: `Upload${here}`,
        icon: UploadSimple,
        onSelect: () => actions.upload(directory),
      },
    ],
  };

  if (entry === undefined) {
    if (canWrite) return [create];
    return [
      {
        items: [{ id: 'read-only', label: 'New file', icon: FilePlus, disabledReason: READ_ONLY }],
      },
    ];
  }

  const path = entry.path;
  const groups: MenuGroup[] = [];
  if (canWrite) {
    groups.push(create);
    groups.push({
      items: [
        {
          id: 'rename',
          label: 'Rename',
          icon: PencilSimple,
          shortcut: ['F2'],
          onSelect: () => actions.rename(path),
        },
        ...(isFolder
          ? []
          : [{ id: 'duplicate', label: 'Duplicate', onSelect: () => actions.duplicate(path) }]),
        { id: 'move', label: 'Move to…', onSelect: () => actions.move(path) },
      ],
    });
  }
  groups.push({
    items: [
      { id: 'copy-path', label: 'Copy path', icon: Copy, onSelect: () => actions.copyPath(path) },
      ...(isFolder
        ? []
        : [
            {
              id: 'download',
              label: 'Download',
              icon: DownloadSimple,
              onSelect: () => actions.download(path),
            },
          ]),
    ],
  });
  if (canWrite) {
    groups.push({
      items: [
        {
          id: 'delete',
          label: 'Delete',
          icon: Trash,
          tone: 'danger',
          shortcut: ['Delete'],
          onSelect: () => actions.remove(path),
        },
      ],
    });
  }
  return groups;
}

/**
 * Right-click (or Shift+F10, the Menu key, a long press) anywhere in the tree.
 *
 * One menu for the whole area rather than one per row: which row it is about
 * is read from the element that was clicked, and the empty space below the
 * last row gets the root's items.
 */
export function FileContextMenu({
  entries,
  canWrite,
  actions,
  className,
  children,
  onCloseAutoFocus,
}: {
  entries: readonly FileEntry[];
  canWrite: boolean;
  actions: FileMenuActions;
  className?: string;
  children: ReactNode;
  /** The menu is closing; prevent it to keep focus where an item put it. */
  onCloseAutoFocus?: (event: Event) => void;
}): ReactElement {
  const [target, setTarget] = useState<FileEntry | undefined>();

  const onContextMenu = (event: MouseEvent<HTMLDivElement>): void => {
    const row = (event.target as Element).closest<HTMLElement>('[data-path]');
    const path = row?.dataset.path;
    setTarget(path === undefined ? undefined : entries.find((entry) => entry.path === path));
  };

  return (
    <ContextMenu
      groups={fileMenuGroups(target, canWrite, actions)}
      label={target ? `Actions for ${target.name}` : 'File actions'}
      {...(onCloseAutoFocus ? { onCloseAutoFocus } : {})}
    >
      <div className={className} onContextMenu={onContextMenu}>
        {children}
      </div>
    </ContextMenu>
  );
}
