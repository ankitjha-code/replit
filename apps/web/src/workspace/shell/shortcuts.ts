import { useEffect, useRef } from 'react';
import { isApplePlatform } from '../../ui/index.js';

export interface ShortcutHandlers {
  palette: () => void;
  quickOpen: () => void;
  run: () => void;
  stopApp: () => void;
  restartApp: () => void;
  toggleFiles: () => void;
  toggleConsole: () => void;
  togglePreview: () => void;
  maximise: () => void;
  shortcuts: () => void;
  focusTerminal: () => void;
  newTerminal: () => void;
  searchFiles: () => void;
}

export const WORKSPACE_EVENTS = {
  focusTerminal: 'workspace:focus-terminal',
  newTerminal: 'workspace:new-terminal',
  searchFiles: 'workspace:search-files',
  newFile: 'workspace:new-file',
  newFolder: 'workspace:new-folder',
} as const;

export function dispatchWorkspaceEvent(
  name: (typeof WORKSPACE_EVENTS)[keyof typeof WORKSPACE_EVENTS],
): void {
  document.dispatchEvent(new CustomEvent(name));
}

export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return target.closest('.monaco-editor, .xterm') !== null;
}

function inMonaco(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && target.closest('.monaco-editor') !== null;
}

export function useWorkspaceShortcuts(handlers: ShortcutHandlers): void {
  const latest = useRef(handlers);
  latest.current = handlers;

  useEffect(() => {
    const apple = isApplePlatform();
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented) return;
      const mod = apple ? event.metaKey : event.ctrlKey;
      const typing = isTypingTarget(event.target);
      const key = event.key;
      const h = latest.current;

      const fire = (action: () => void): void => {
        event.preventDefault();
        action();
      };

      if (mod && key === 'Enter') {
        if (event.shiftKey) return fire(h.stopApp);
        return fire(h.run);
      }
      if (mod && event.shiftKey && (key === 'R' || key === 'r')) return fire(h.restartApp);

      if (mod && (key === 'k' || key === 'K')) return fire(h.palette);
      if (mod && !event.shiftKey && (key === 'p' || key === 'P')) return fire(h.quickOpen);
      if (mod && key === '`') return fire(event.shiftKey ? h.newTerminal : h.focusTerminal);

      const searchKey = (event.ctrlKey || mod) && event.shiftKey && (key === 'F' || key === 'f');
      if (searchKey && (!typing || inMonaco(event.target))) return fire(h.searchFiles);

      if (typing) return;

      if (event.ctrlKey && !event.metaKey) {
        if (event.shiftKey && (key === 'V' || key === 'v')) return fire(h.togglePreview);
        if (event.shiftKey && (key === 'M' || key === 'm')) return fire(h.maximise);
        if (!event.shiftKey && (key === 'b' || key === 'B')) return fire(h.toggleFiles);
        if (!event.shiftKey && (key === 'j' || key === 'J')) return fire(h.toggleConsole);
      }

      if (key === '?' && !mod && !event.altKey) return fire(h.shortcuts);
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}
