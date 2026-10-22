import type { editor } from 'monaco-editor';
import { editorTheme, editorThemeName, type EditorThemeName } from '../../theme/editor-theme.js';
import { THEME_CHANGE_EVENT, getThemeState, type Theme } from '../../theme/theme.js';

/**
 * Keeps Monaco's theme in step with the application's.
 *
 * Separate from monaco-setup.ts so it can be tested without loading Monaco:
 * the host is the two functions this needs, and a fake stands in for them.
 */
export interface EditorThemeHost {
  defineTheme: (name: string, data: editor.IStandaloneThemeData) => void;
  setTheme: (name: string) => void;
}

/**
 * Builds the theme for `theme` from the tokens the browser is showing right
 * now, registers it and switches to it. Called after the document attribute
 * flipped, so the tokens read are the new theme's (see theme/editor-theme.ts).
 */
export function applyEditorTheme(
  host: EditorThemeHost,
  theme: Theme = getThemeState().theme,
): EditorThemeName {
  const name = editorThemeName(theme);
  host.defineTheme(name, editorTheme(theme));
  host.setTheme(name);
  return name;
}

/** Applies the current theme now and again on every `themechange`. Returns the unsubscribe. */
export function followTheme(host: EditorThemeHost, target: Document = document): () => void {
  applyEditorTheme(host);
  const onChange = (event: Event): void => {
    const detail = (event as CustomEvent<{ theme: Theme }>).detail;
    applyEditorTheme(host, detail.theme);
  };
  target.addEventListener(THEME_CHANGE_EVENT, onChange);
  return () => target.removeEventListener(THEME_CHANGE_EVENT, onChange);
}

/** The theme name an editor created right now should start with. */
export function currentEditorThemeName(): EditorThemeName {
  return editorThemeName(getThemeState().theme);
}
