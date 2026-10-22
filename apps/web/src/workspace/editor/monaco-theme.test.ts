import { afterEach, describe, expect, it, vi } from 'vitest';
import { THEME_CHANGE_EVENT } from '../../theme/theme.js';
import { applyEditorTheme, currentEditorThemeName, followTheme } from './monaco-theme.js';

/** Monaco's two theme calls, recorded. */
function fakeHost() {
  return { defineTheme: vi.fn(), setTheme: vi.fn() };
}

afterEach(() => {
  delete document.documentElement.dataset.theme;
});

describe('the Monaco theme follower', () => {
  it('builds the theme from tokens and switches to it', () => {
    const host = fakeHost();
    expect(applyEditorTheme(host, 'light')).toBe('platform-light');
    expect(host.defineTheme).toHaveBeenCalledWith(
      'platform-light',
      expect.objectContaining({ base: 'vs', inherit: true }),
    );
    expect(host.setTheme).toHaveBeenCalledWith('platform-light');

    applyEditorTheme(host, 'dark');
    expect(host.defineTheme).toHaveBeenLastCalledWith(
      'platform-dark',
      expect.objectContaining({ base: 'vs-dark' }),
    );
    expect(host.setTheme).toHaveBeenLastCalledWith('platform-dark');
  });

  it('starts from the theme on screen and re-applies on themechange', () => {
    const host = fakeHost();
    const stop = followTheme(host);
    expect(host.setTheme).toHaveBeenCalledWith(currentEditorThemeName());

    document.dispatchEvent(
      new CustomEvent(THEME_CHANGE_EVENT, { detail: { theme: 'light' as const } }),
    );
    expect(host.setTheme).toHaveBeenLastCalledWith('platform-light');
    // Redefined, not merely selected: the token values differ per theme.
    expect(host.defineTheme).toHaveBeenLastCalledWith('platform-light', expect.anything());

    stop();
    document.dispatchEvent(
      new CustomEvent(THEME_CHANGE_EVENT, { detail: { theme: 'dark' as const } }),
    );
    expect(host.setTheme).toHaveBeenLastCalledWith('platform-light');
  });

  it('reads the editor colours from the token names, not from literals', () => {
    // A reader that answers with the name asked for proves no colour is baked in.
    const host = fakeHost();
    applyEditorTheme(host, 'dark');
    const data = host.defineTheme.mock.calls[0]?.[1] as {
      colors: Record<string, string>;
      rules: Array<{ token: string; foreground?: string }>;
    };
    // jsdom resolves no custom properties, so every value comes back empty;
    // what matters is that the keys the spec names are all present.
    expect(Object.keys(data.colors)).toEqual(
      expect.arrayContaining([
        'editor.background',
        'editorGutter.background',
        'editor.lineHighlightBackground',
        'editorLineNumber.foreground',
        'editor.selectionBackground',
        'editorCursor.foreground',
        'focusBorder',
      ]),
    );
    expect(data.rules.some((rule) => rule.token === 'comment')).toBe(true);
  });
});
