export function portalRoot(): HTMLElement | undefined {
  if (typeof document === 'undefined') return undefined;
  return document.getElementById('overlays') ?? undefined;
}
