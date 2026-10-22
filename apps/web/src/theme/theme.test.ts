import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { editorTheme, editorThemeName } from './editor-theme.js';
import { terminalTheme } from './terminal-theme.js';
import {
  THEME_STORAGE_KEY,
  getThemeState,
  initTheme,
  setThemePreference,
  subscribeTheme,
  type Theme,
} from './theme.js';
import { useTheme } from './use-theme.js';

/** A matchMedia the test can flip, standing in for the OS setting. */
function fakeMedia(initial: boolean) {
  const listeners = new Set<() => void>();
  const list = {
    matches: initial,
    media: '(prefers-color-scheme: light)',
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
    dispatchEvent: () => false,
  };
  window.matchMedia = () => list as unknown as MediaQueryList;
  return {
    flip(matches: boolean) {
      list.matches = matches;
      for (const listener of listeners) listener();
    },
  };
}

function themeEvents(): Theme[] {
  const seen: Theme[] = [];
  document.addEventListener('themechange', (event) => seen.push(event.detail.theme));
  return seen;
}

const originalMatchMedia = window.matchMedia;

beforeEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.theme;
});

afterEach(() => {
  window.matchMedia = originalMatchMedia;
  vi.restoreAllMocks();
  localStorage.clear();
  delete document.documentElement.dataset.theme;
});

describe('initTheme', () => {
  it('follows the system when nothing is stored', () => {
    fakeMedia(false);
    expect(initTheme()).toEqual({ theme: 'dark', preference: 'system' });
    expect(document.documentElement.dataset.theme).toBeUndefined();

    fakeMedia(true);
    expect(initTheme()).toEqual({ theme: 'light', preference: 'system' });
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });

  it('applies a stored choice as the data-theme attribute, whatever the system says', () => {
    fakeMedia(false);
    localStorage.setItem(THEME_STORAGE_KEY, 'light');
    expect(initTheme()).toEqual({ theme: 'light', preference: 'light' });
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('ignores a stored value it does not recognise', () => {
    fakeMedia(false);
    localStorage.setItem(THEME_STORAGE_KEY, 'sepia');
    expect(initTheme()).toEqual({ theme: 'dark', preference: 'system' });
  });

  it('survives storage that throws', () => {
    fakeMedia(false);
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(initTheme()).toEqual({ theme: 'dark', preference: 'system' });
  });
});

describe('setThemePreference', () => {
  it('stores the choice, sets the attribute and announces the new theme', () => {
    fakeMedia(false);
    initTheme();
    const seen = themeEvents();

    setThemePreference('light');
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
    expect(getThemeState()).toEqual({ theme: 'light', preference: 'light' });
    expect(seen).toEqual(['light']);

    setThemePreference('system');
    expect(document.documentElement.dataset.theme).toBeUndefined();
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    expect(seen).toEqual(['light', 'dark']);
  });

  it('tells subscribers about a preference change even when the theme stays', () => {
    fakeMedia(false);
    initTheme();
    const seen = themeEvents();
    const listener = vi.fn();
    subscribeTheme(listener);

    setThemePreference('dark');
    expect(listener).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([]);
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('keeps working when storage cannot be written', () => {
    fakeMedia(false);
    initTheme();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    setThemePreference('light');
    expect(getThemeState().theme).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');
  });
});

describe('system changes', () => {
  it('announces the flip while the preference is system', () => {
    const media = fakeMedia(false);
    initTheme();
    const seen = themeEvents();
    media.flip(true);
    expect(getThemeState()).toEqual({ theme: 'light', preference: 'system' });
    expect(seen).toEqual(['light']);
  });

  it('ignores the flip once the user has chosen', () => {
    const media = fakeMedia(false);
    initTheme();
    setThemePreference('dark');
    const seen = themeEvents();
    media.flip(true);
    expect(getThemeState().theme).toBe('dark');
    expect(seen).toEqual([]);
  });
});

describe('useTheme', () => {
  it('re-renders with the new theme and preference', () => {
    fakeMedia(false);
    initTheme();
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe('dark');
    expect(result.current.preference).toBe('system');

    act(() => result.current.setPreference('light'));
    expect(result.current.theme).toBe('light');
    expect(result.current.preference).toBe('light');
  });
});

describe('theme builders', () => {
  const read = (name: string) =>
    `#${name
      .replace(/[^a-z]/g, '')
      .slice(0, 6)
      .padEnd(6, '0')}`;

  it('name Monaco themes per theme and base them on vs / vs-dark', () => {
    expect(editorThemeName('dark')).toBe('platform-dark');
    expect(editorThemeName('light')).toBe('platform-light');
    expect(editorTheme('dark', read).base).toBe('vs-dark');
    expect(editorTheme('light', read).base).toBe('vs');
  });

  it('build Monaco colours and token rules from the tokens, hex without the hash in rules', () => {
    const theme = editorTheme('dark', read);
    expect(theme.colors['editor.background']).toBe(read('--bg-canvas'));
    expect(theme.colors['editorCursor.foreground']).toBe(read('--accent'));
    const keyword = theme.rules.find((rule) => rule.token === 'keyword');
    expect(keyword?.foreground).toBe(read('--code-keyword').slice(1));
    const comment = theme.rules.find((rule) => rule.token === 'comment');
    expect(comment?.fontStyle).toBe('');
  });

  it('build the xterm theme from the tokens with bright white as primary text', () => {
    const theme = terminalTheme('dark', read);
    expect(theme.background).toBe(read('--bg-canvas'));
    expect(theme.foreground).toBe(read('--text-primary'));
    expect(theme.brightWhite).toBe(read('--text-primary'));
    expect(theme.cursor).toBe(read('--accent'));
    expect(theme.selectionBackground).toBe(read('--selection'));
  });
});
