import { createContext, useContext } from 'react';

/**
 * What the panels may ask the workspace frame to do (design spec 12.1 item 4).
 *
 * The frame owns the toolbar, the layout and the project event stream; the
 * panels own their own buttons and state. This context is how they meet
 * without importing each other: a panel calls `showPanel('console')`, the
 * console registers its Run button so the frame's shortcuts and `focusRun()`
 * can reach it. Every function is safe to call before anything registered:
 * it does nothing.
 */

export type WorkspacePanelName = 'files' | 'editor' | 'console' | 'preview';

export type ConsoleTab = 'output' | 'shell';

/** The console's run controls, registered by the console package. */
export interface RunActions {
  run: () => void | Promise<void>;
  stop: () => void | Promise<void>;
  restart: () => void | Promise<void>;
}

/** What the preview knows that the layout needs (spec 9.9: the framed width). */
export interface PreviewReport {
  /** An application answered on a port. */
  listening: boolean;
  /** The browser can show it inside the workspace rather than only in a tab. */
  framable: boolean;
}

export interface WorkspaceActions {
  /**
   * Call after creating, renaming or deleting files from inside the
   * workspace. Reloads the explorer and, while nothing is running, asks the
   * server again which runtime the project needs (bug 1 in the audit).
   */
  onFilesChanged: () => void;
  /** Bumped when the server says the application started or stopped. */
  runNonce: number;
  /** Moves focus to the Start button in the toolbar and flashes it. */
  focusStart: () => void;
  /** Moves focus to the console's Run button, when the console registered one. */
  focusRun: () => void;
  /** Brings the Output or Shell tab forward, when the console registered a selector. */
  selectConsoleTab: (tab: ConsoleTab) => void;
  /** Expands a collapsed panel; on a phone, switches to it. */
  showPanel: (name: WorkspacePanelName) => void;
  /** The console registers its Run button here; `null` on unmount. */
  registerRunTarget: (element: HTMLElement | null) => void;
  /** The console registers run/stop/restart here; the frame's shortcuts call them. */
  registerRunActions: (actions: RunActions | null) => void;
  /** The console registers how to switch its tabs; backs `selectConsoleTab`. */
  registerConsoleTabSelector: (select: ((tab: ConsoleTab) => void) | null) => void;
  /** The preview reports whether something is listening and framable; `null` on unmount. */
  reportPreview: (report: PreviewReport | null) => void;
  /** Opens Share; with `'preview-link'`, at the preview link section. */
  openShare: (section?: ShareSection) => void;
}

/** A part of the Share popover that can be opened straight to. */
export type ShareSection = 'preview-link';

const noop = (): void => undefined;

/**
 * Permissive defaults so a panel rendered on its own (unit tests, the
 * gallery) never has to provide the frame.
 */
export const NO_WORKSPACE_ACTIONS: WorkspaceActions = {
  onFilesChanged: noop,
  runNonce: 0,
  focusStart: noop,
  focusRun: noop,
  selectConsoleTab: noop,
  showPanel: noop,
  registerRunTarget: noop,
  registerRunActions: noop,
  registerConsoleTabSelector: noop,
  reportPreview: noop,
  openShare: noop,
};

export const WorkspaceActionsContext = createContext<WorkspaceActions>(NO_WORKSPACE_ACTIONS);

export function useWorkspaceActions(): WorkspaceActions {
  return useContext(WorkspaceActionsContext);
}

/** The class `base.css` animates for "Show me"; a static outline under reduced motion. */
export const GUIDE_FLASH_CLASS = 'ui-guide-flash';
const GUIDE_FLASH_MS = 3_600;

/**
 * Focuses an element and flashes its focus ring so a first-time user can find
 * it. Used by `focusStart`, `focusRun` and the guide strip's "Show me".
 */
export function flashElement(element: HTMLElement | null | undefined): void {
  if (!element) return;
  element.focus({ preventScroll: false });
  element.classList.add(GUIDE_FLASH_CLASS);
  setTimeout(() => element.classList.remove(GUIDE_FLASH_CLASS), GUIDE_FLASH_MS);
}
