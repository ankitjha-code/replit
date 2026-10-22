import { useRef, useState, type DragEvent, type ReactElement, type ReactNode } from 'react';

/** What a drop from the device carried: files to send, and folders that cannot be. */
export interface DroppedFiles {
  files: File[];
  folders: string[];
}

/**
 * Reads a drop's files. Must run inside the drop event: the browser empties
 * the DataTransfer as soon as the handler returns.
 *
 * A dropped folder arrives as a File too, one that cannot be read. The entry
 * API tells the two apart where the browser has it, so a folder is refused
 * by name rather than failing as an unreadable file.
 */
export function filesFromDataTransfer(data: DataTransfer): DroppedFiles {
  const files: File[] = [];
  const folders: string[] = [];
  const items = Array.from(data.items ?? []);

  if (items.length > 0) {
    for (const item of items) {
      if (item.kind !== 'file') continue;
      const entry = item.webkitGetAsEntry?.();
      const file = item.getAsFile();
      if (entry?.isDirectory) folders.push(entry.name);
      else if (file) files.push(file);
    }
    return { files, folders };
  }

  return { files: Array.from(data.files ?? []), folders };
}

function isFileDrag(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes('Files');
}

/**
 * The whole Files panel accepts files dragged in from the device (design
 * spec 9.4). A drop on a folder row is handled by the tree, which knows the
 * folder; anywhere else lands in the project root.
 */
export function UploadDropZone({
  enabled,
  onDrop,
  className,
  children,
}: {
  enabled: boolean;
  onDrop: (data: DataTransfer, directory: string) => void;
  className?: string;
  children: ReactNode;
}): ReactElement {
  const [over, setOver] = useState(false);
  const depth = useRef(0);

  if (!enabled) return <div className={className}>{children}</div>;

  return (
    <div
      className={`${className ?? ''}${over ? ' files-dropzone--over' : ''}`}
      data-drop-label={over ? 'Upload to the project root' : undefined}
      // Counted because dragenter and dragleave fire for every child crossed.
      onDragEnter={(event) => {
        if (isFileDrag(event)) depth.current += 1;
      }}
      onDragLeave={(event) => {
        if (!isFileDrag(event)) return;
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) setOver(false);
      }}
      onDragOver={(event) => {
        if (!isFileDrag(event)) return;
        // The tree already took it (a folder row, or its own root area).
        if (event.nativeEvent.defaultPrevented) {
          setOver(false);
          return;
        }
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
        setOver(true);
      }}
      onDrop={(event) => {
        depth.current = 0;
        setOver(false);
        if (!isFileDrag(event)) return;
        event.preventDefault();
        onDrop(event.dataTransfer, '');
      }}
    >
      {children}
    </div>
  );
}
