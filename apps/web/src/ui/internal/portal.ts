/**
 * Where Radix portals mount. index.html provides #overlays so overlays stack
 * above the app root; a test document without it falls back to the body.
 */
export function portalRoot(): HTMLElement | undefined {
  if (typeof document === 'undefined') return undefined;
  return document.getElementById('overlays') ?? undefined;
}
