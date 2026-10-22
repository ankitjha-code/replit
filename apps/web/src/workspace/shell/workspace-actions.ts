import { createContext, useContext } from 'react';

export type WorkspacePanelName = 'files' | 'editor' | 'console' | 'preview';

export type ConsoleTab = 'output' | 'shell';

export interface RunActions {
  run: () => void | Promise<void>;
  stop: () => void | Promise<void>;
  restart: () => void | Promise<void>;
}

export interface PreviewReport {
  listening: boolean;
  framable: boolean;
}

export interface WorkspaceActions {
  onFilesChanged: () => void;
  runNonce: number;
  focusStart: () => void;
  focusRun: () => void;
  selectConsoleTab: (tab: ConsoleTab) => void;
  showPanel: (name: WorkspacePanelName) => void;
  registerRunTarget: (element: HTMLElement | null) => void;
  registerRunActions: (actions: RunActions | null) => void;
  registerConsoleTabSelector: (select: ((tab: ConsoleTab) => void) | null) => void;
  reportPreview: (report: PreviewReport | null) => void;
  openShare: (section?: ShareSection) => void;
}

export type ShareSection = 'preview-link';

const noop = (): void => undefined;

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

export const GUIDE_FLASH_CLASS = 'ui-guide-flash';
const GUIDE_FLASH_MS = 3_600;

export function flashElement(element: HTMLElement | null | undefined): void {
  if (!element) return;
  element.focus({ preventScroll: false });
  element.classList.add(GUIDE_FLASH_CLASS);
  setTimeout(() => element.classList.remove(GUIDE_FLASH_CLASS), GUIDE_FLASH_MS);
}
