import type { editor } from 'monaco-editor';
import { editorTheme, editorThemeName, type EditorThemeName } from '../../theme/editor-theme.js';
import { THEME_CHANGE_EVENT, getThemeState, type Theme } from '../../theme/theme.js';

export interface EditorThemeHost {
  defineTheme: (name: string, data: editor.IStandaloneThemeData) => void;
  setTheme: (name: string) => void;
}

export function applyEditorTheme(
  host: EditorThemeHost,
  theme: Theme = getThemeState().theme,
): EditorThemeName {
  const name = editorThemeName(theme);
  host.defineTheme(name, editorTheme(theme));
  host.setTheme(name);
  return name;
}

export function followTheme(host: EditorThemeHost, target: Document = document): () => void {
  applyEditorTheme(host);
  const onChange = (event: Event): void => {
    const detail = (event as CustomEvent<{ theme: Theme }>).detail;
    applyEditorTheme(host, detail.theme);
  };
  target.addEventListener(THEME_CHANGE_EVENT, onChange);
  return () => target.removeEventListener(THEME_CHANGE_EVENT, onChange);
}

export function currentEditorThemeName(): EditorThemeName {
  return editorThemeName(getThemeState().theme);
}
