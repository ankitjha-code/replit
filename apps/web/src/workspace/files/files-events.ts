export const FILES_EVENTS = {
  upload: 'workspace:upload-files',
  sync: 'workspace:sync-files',
} as const;

export function dispatchFilesEvent(name: (typeof FILES_EVENTS)[keyof typeof FILES_EVENTS]): void {
  document.dispatchEvent(new CustomEvent(name));
}
