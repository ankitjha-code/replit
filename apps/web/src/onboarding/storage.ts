/**
 * localStorage behind try/catch.
 *
 * Private windows, cleared site data and some embedded browsers throw on
 * access; a first-run hint or a sort preference is never worth an error.
 */
export function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStorage(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Nothing to do: the preference simply does not persist.
  }
}

export function removeStorage(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // As above.
  }
}
