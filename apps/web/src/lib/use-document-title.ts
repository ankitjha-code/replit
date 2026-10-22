import { useEffect } from 'react';

/** The product's name until the owner picks one; matches the static title in index.html. */
export const DOCUMENT_TITLE_BRAND = 'Workspace';

const SEPARATOR = ' · ';

/**
 * Builds the tab title from the most specific part outward, ending with the
 * brand: `index.js · Hello World · Workspace`. Empty parts are skipped so a
 * page can pass a name it has not loaded yet. `dirty` prefixes the unsaved
 * marker without joining it as a part.
 */
export function formatDocumentTitle(
  parts: ReadonlyArray<string | null | undefined | false>,
  options: { dirty?: boolean } = {},
): string {
  const words = parts.filter((part): part is string => typeof part === 'string' && part !== '');
  const title = [...words, DOCUMENT_TITLE_BRAND].join(SEPARATOR);
  return options.dirty ? `● ${title}` : title;
}

export function useDocumentTitle(
  parts: ReadonlyArray<string | null | undefined | false>,
  options: { dirty?: boolean } = {},
): void {
  const title = formatDocumentTitle(parts, options);
  useEffect(() => {
    document.title = title;
  }, [title]);
}
