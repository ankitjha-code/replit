const TABBABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** The first element a Tab would reach inside `root`, if any. */
export function firstTabbable(root: ParentNode | null | undefined): HTMLElement | undefined {
  if (!root) return undefined;
  for (const element of root.querySelectorAll<HTMLElement>(TABBABLE)) {
    if (!element.closest('[aria-hidden="true"]')) return element;
  }
  return undefined;
}
