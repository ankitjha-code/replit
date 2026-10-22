import { useRef, useState, type DragEvent, type ReactElement, type ReactNode } from 'react';

export interface DroppedFiles {
  files: File[];
  folders: string[];
}

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
