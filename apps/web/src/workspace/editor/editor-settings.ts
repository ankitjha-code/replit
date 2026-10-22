import { useSyncExternalStore } from 'react';

/**
 * Per-viewer editor preferences (design spec 9.5 and 3).
 *
 * Stored in this browser only: how big the code is and whether it wraps is a
 * matter of eyesight and screen, not of the project, so it is never sent to
 * the server. Every open editor follows the same store, so changing a value in
 * the dialog or from the palette updates each of them at once.
 */
export interface EditorSettings {
  /** Pixels, 11 to 18. */
  fontSize: number;
  ligatures: boolean;
  wordWrap: boolean;
  minimap: boolean;
  tabSize: 2 | 4 | 8;
}

export const EDITOR_SETTINGS_KEY = 'ui.editor';
export const FONT_SIZE_MIN = 11;
export const FONT_SIZE_MAX = 18;

export const DEFAULT_EDITOR_SETTINGS: EditorSettings = {
  fontSize: 13,
  ligatures: false,
  wordWrap: true,
  minimap: false,
  tabSize: 2,
};

/** Dispatched on `document` to open the settings dialog from anywhere (the palette). */
export const EDITOR_SETTINGS_OPEN_EVENT = 'editor:settings';

const listeners = new Set<() => void>();
let current: EditorSettings | undefined;

function clampFontSize(value: number): number {
  return Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, Math.round(value)));
}

function sanitise(candidate: unknown): EditorSettings {
  if (typeof candidate !== 'object' || candidate === null) return DEFAULT_EDITOR_SETTINGS;
  const raw = candidate as Partial<Record<keyof EditorSettings, unknown>>;
  return {
    fontSize:
      typeof raw.fontSize === 'number' && Number.isFinite(raw.fontSize)
        ? clampFontSize(raw.fontSize)
        : DEFAULT_EDITOR_SETTINGS.fontSize,
    ligatures:
      typeof raw.ligatures === 'boolean' ? raw.ligatures : DEFAULT_EDITOR_SETTINGS.ligatures,
    wordWrap: typeof raw.wordWrap === 'boolean' ? raw.wordWrap : DEFAULT_EDITOR_SETTINGS.wordWrap,
    minimap: typeof raw.minimap === 'boolean' ? raw.minimap : DEFAULT_EDITOR_SETTINGS.minimap,
    tabSize:
      raw.tabSize === 2 || raw.tabSize === 4 || raw.tabSize === 8
        ? raw.tabSize
        : DEFAULT_EDITOR_SETTINGS.tabSize,
  };
}

function read(): EditorSettings {
  // Storage can be blocked (private mode, disabled cookies); defaults then apply.
  try {
    const raw = window.localStorage.getItem(EDITOR_SETTINGS_KEY);
    return raw ? sanitise(JSON.parse(raw)) : DEFAULT_EDITOR_SETTINGS;
  } catch {
    return DEFAULT_EDITOR_SETTINGS;
  }
}

function write(settings: EditorSettings): void {
  try {
    window.localStorage.setItem(EDITOR_SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // The choice still applies for this page view.
  }
}

export function getEditorSettings(): EditorSettings {
  current ??= read();
  return current;
}

export function subscribeEditorSettings(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function updateEditorSettings(patch: Partial<EditorSettings>): EditorSettings {
  const next = sanitise({ ...getEditorSettings(), ...patch });
  current = next;
  write(next);
  for (const listener of listeners) listener();
  return next;
}

export function resetEditorSettings(): EditorSettings {
  return updateEditorSettings(DEFAULT_EDITOR_SETTINGS);
}

/** Font size up or down by `delta` pixels, kept within the allowed range. */
export function adjustEditorFontSize(delta: number): EditorSettings {
  return updateEditorSettings({ fontSize: getEditorSettings().fontSize + delta });
}

/** Asks the mounted editor panel to open its settings dialog. */
export function openEditorSettings(): void {
  document.dispatchEvent(new CustomEvent(EDITOR_SETTINGS_OPEN_EVENT));
}

export function useEditorSettings(): EditorSettings {
  return useSyncExternalStore(subscribeEditorSettings, getEditorSettings, getEditorSettings);
}

/** Forgets the cached value, so a test that changes storage sees the change. */
export function resetEditorSettingsCache(): void {
  current = undefined;
}
