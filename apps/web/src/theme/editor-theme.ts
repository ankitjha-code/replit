import type { editor } from 'monaco-editor';
import { readToken, type TokenReader } from './read-tokens.js';
import type { Theme } from './theme.js';

export type EditorThemeName = 'platform-dark' | 'platform-light';

export function editorThemeName(theme: Theme): EditorThemeName {
  return theme === 'light' ? 'platform-light' : 'platform-dark';
}

/**
 * Monaco theme data built from the live tokens. Call it on `themechange`, after
 * the document attribute has flipped, so the values read are the new theme's.
 */
export function editorTheme(
  theme: Theme,
  read: TokenReader = readToken,
): editor.IStandaloneThemeData {
  const hex = (name: string) => read(name).replace('#', '');
  const keyword = hex('--code-keyword');
  const string = hex('--code-string');
  const number = hex('--code-number');
  const comment = hex('--code-comment');
  const type = hex('--code-type');
  const fn = hex('--code-function');
  const variable = hex('--code-variable');
  const punctuation = hex('--code-punctuation');

  return {
    base: theme === 'light' ? 'vs' : 'vs-dark',
    inherit: true,
    rules: [
      { token: '', foreground: variable },
      { token: 'keyword', foreground: keyword },
      { token: 'keyword.operator', foreground: punctuation },
      { token: 'string', foreground: string },
      { token: 'string.escape', foreground: number },
      { token: 'regexp', foreground: string },
      { token: 'number', foreground: number },
      { token: 'constant', foreground: number },
      // Comment italics are off on purpose: italic mono is hard to read at 13px.
      { token: 'comment', foreground: comment, fontStyle: '' },
      { token: 'type', foreground: type },
      { token: 'type.identifier', foreground: type },
      { token: 'tag', foreground: type },
      { token: 'metatag', foreground: type },
      { token: 'attribute.name', foreground: fn },
      { token: 'attribute.value', foreground: string },
      { token: 'identifier.function', foreground: fn },
      { token: 'function', foreground: fn },
      { token: 'variable', foreground: variable },
      { token: 'identifier', foreground: variable },
      { token: 'delimiter', foreground: punctuation },
      { token: 'operator', foreground: punctuation },
    ],
    colors: {
      'editor.background': read('--bg-canvas'),
      'editor.foreground': read('--text-primary'),
      'editorGutter.background': read('--bg-canvas'),
      'editor.lineHighlightBackground': read('--line-highlight'),
      'editorLineNumber.foreground': read('--text-muted'),
      'editorLineNumber.activeForeground': read('--text-secondary'),
      'editor.selectionBackground': read('--selection'),
      'editorIndentGuide.background1': read('--border-subtle'),
      'editorWidget.background': read('--bg-overlay'),
      'editorWidget.border': read('--border-strong'),
      focusBorder: read('--focus'),
      'editorCursor.foreground': read('--accent'),
    },
  };
}
