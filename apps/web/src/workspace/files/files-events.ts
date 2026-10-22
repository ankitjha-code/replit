/**
 * Document events the Files panel listens for, beside the frame's own
 * `WORKSPACE_EVENTS` (new file, new folder, search). The command palette can
 * dispatch these for its "Upload files" and "Sync files" entries; with the
 * panel unmounted they do nothing.
 */
export const FILES_EVENTS = {
  upload: 'workspace:upload-files',
  sync: 'workspace:sync-files',
} as const;

export function dispatchFilesEvent(name: (typeof FILES_EVENTS)[keyof typeof FILES_EVENTS]): void {
  document.dispatchEvent(new CustomEvent(name));
}
