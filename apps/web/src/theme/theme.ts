/**
 * Theme bootstrap. Runs before React renders (main.tsx calls initTheme right
 * after the CSS imports) so the first paint already carries the stored choice
 * and no inline script is needed, which the CSP forbids.
 *
 * The preference is what the user asked for; the theme is what is on screen.
 * With 'system' the two can differ, and the media query decides.
 */
export type ThemePreference = 'system' | 'dark' | 'light';
export type Theme = 'dark' | 'light';

export interface ThemeState {
  theme: Theme;
  preference: ThemePreference;
}

export const THEME_STORAGE_KEY = 'ui.theme';
export const THEME_CHANGE_EVENT = 'themechange';

declare global {
  interface DocumentEventMap {
    themechange: CustomEvent<{ theme: Theme }>;
  }
}

const LIGHT_QUERY = '(prefers-color-scheme: light)';

const listeners = new Set<() => void>();
let state: ThemeState = { theme: 'dark', preference: 'system' };
let mediaQuery: MediaQueryList | undefined;

function isPreference(value: unknown): value is ThemePreference {
  return value === 'system' || value === 'dark' || value === 'light';
}

function readStoredPreference(): ThemePreference {
  // Storage can be blocked (private mode, disabled cookies); the app still runs.
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isPreference(stored) ? stored : 'system';
  } catch {
    return 'system';
  }
}

function writeStoredPreference(preference: ThemePreference): void {
  try {
    if (preference === 'system') window.localStorage.removeItem(THEME_STORAGE_KEY);
    else window.localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // Nothing to do: the choice still applies for this page view.
  }
}

function systemTheme(): Theme {
  return mediaQuery?.matches ? 'light' : 'dark';
}

export function resolveTheme(preference: ThemePreference): Theme {
  return preference === 'system' ? systemTheme() : preference;
}

function apply(preference: ThemePreference): void {
  const theme = resolveTheme(preference);
  const root = document.documentElement;
  if (preference === 'system') delete root.dataset.theme;
  else root.dataset.theme = preference;

  const changed = theme !== state.theme || preference !== state.preference;
  const themeChanged = theme !== state.theme;
  state = { theme, preference };
  if (!changed) return;

  for (const listener of listeners) listener();
  if (themeChanged) {
    document.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT, { detail: { theme } }));
  }
}

function onMediaChange(): void {
  if (state.preference === 'system') apply('system');
}

/** Applies the stored preference and follows the OS while it is 'system'. */
export function initTheme(): ThemeState {
  mediaQuery?.removeEventListener('change', onMediaChange);
  mediaQuery = typeof window.matchMedia === 'function' ? window.matchMedia(LIGHT_QUERY) : undefined;
  mediaQuery?.addEventListener('change', onMediaChange);

  const preference = readStoredPreference();
  const root = document.documentElement;
  if (preference === 'system') delete root.dataset.theme;
  else root.dataset.theme = preference;
  state = { theme: resolveTheme(preference), preference };
  return state;
}

export function getThemeState(): ThemeState {
  return state;
}

export function setThemePreference(preference: ThemePreference): void {
  writeStoredPreference(preference);
  apply(preference);
}

/** Fires on any change to the theme or the preference. Returns the unsubscribe. */
export function subscribeTheme(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
