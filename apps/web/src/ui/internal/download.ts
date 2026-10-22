/** `download` as an anchor attribute: true asks for the server's file name. */
export function downloadProp(download: string | boolean | undefined): { download?: string } {
  if (download === undefined || download === false) return {};
  return { download: download === true ? '' : download };
}
