export function downloadProp(download: string | boolean | undefined): { download?: string } {
  if (download === undefined || download === false) return {};
  return { download: download === true ? '' : download };
}
