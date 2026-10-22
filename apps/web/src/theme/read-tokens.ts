/**
 * Reads design tokens as the browser currently resolves them, so a theme built
 * from them (Monaco, xterm) always matches what the CSS is showing.
 */
export function readToken(name: string, element: Element = document.documentElement): string {
  return getComputedStyle(element).getPropertyValue(name).trim();
}

export type TokenReader = (name: string) => string;

export function readTokens<const K extends readonly string[]>(
  names: K,
  read: TokenReader = readToken,
): Record<K[number], string> {
  const out = {} as Record<K[number], string>;
  for (const name of names) out[name as K[number]] = read(name);
  return out;
}
