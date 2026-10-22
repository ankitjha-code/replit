import { useEffect } from 'react';

export const DOCUMENT_TITLE_BRAND = 'Workspace';

const SEPARATOR = ' · ';

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
