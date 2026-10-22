import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useWorkspaceShortcuts, type ShortcutHandlers } from './shortcuts.js';

function handlers(): ShortcutHandlers {
  return {
    palette: vi.fn(),
    quickOpen: vi.fn(),
    run: vi.fn(),
    stopApp: vi.fn(),
    restartApp: vi.fn(),
    toggleFiles: vi.fn(),
    toggleConsole: vi.fn(),
    togglePreview: vi.fn(),
    maximise: vi.fn(),
    shortcuts: vi.fn(),
    focusTerminal: vi.fn(),
    newTerminal: vi.fn(),
    searchFiles: vi.fn(),
  };
}

function pressIn(target: HTMLElement, init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

const searchKey = { key: 'F', ctrlKey: true, shiftKey: true };

afterEach(() => {
  document.body.innerHTML = '';
});

describe('Search files (Ctrl+Shift+F)', () => {
  it('works from inside the editor, where people are when they want a file', () => {
    const h = handlers();
    renderHook(() => useWorkspaceShortcuts(h));
    const editor = document.createElement('div');
    editor.className = 'monaco-editor';
    const textarea = document.createElement('textarea');
    editor.append(textarea);
    document.body.append(editor);

    const event = pressIn(textarea, searchKey);
    expect(h.searchFiles).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it('works from the page', () => {
    const h = handlers();
    renderHook(() => useWorkspaceShortcuts(h));
    pressIn(document.body, searchKey);
    expect(h.searchFiles).toHaveBeenCalledTimes(1);
  });

  it('leaves an ordinary field alone', () => {
    const h = handlers();
    renderHook(() => useWorkspaceShortcuts(h));
    const input = document.createElement('input');
    document.body.append(input);
    pressIn(input, searchKey);
    expect(h.searchFiles).not.toHaveBeenCalled();
  });

  it('still keeps the other panel keys out of the editor', () => {
    const h = handlers();
    renderHook(() => useWorkspaceShortcuts(h));
    const editor = document.createElement('div');
    editor.className = 'monaco-editor';
    const textarea = document.createElement('textarea');
    editor.append(textarea);
    document.body.append(editor);
    pressIn(textarea, { key: 'b', ctrlKey: true });
    expect(h.toggleFiles).not.toHaveBeenCalled();
  });
});
