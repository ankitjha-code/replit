import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { WorkspacePanelName } from './shell/workspace-actions.js';

export interface WorkspaceLayout {
  files: number;
  preview: number;
  console: number;
  collapsed: {
    files: boolean;
    preview: boolean;
    console: boolean;
  };
}

export type ResizablePanel = 'files' | 'preview' | 'console';

export const DEFAULT_LAYOUT: WorkspaceLayout = {
  files: 0.16,
  preview: 0.22,
  console: 0.36,
  collapsed: { files: false, preview: false, console: false },
};

const PREVIOUS_DEFAULT_CONSOLE = 0.28;

export const FRAMED_PREVIEW_FRACTION = 0.32;

export const MIN_FRACTION = 0.12;
export const MAX_FRACTION = 0.6;

export const MAX_SIDE_TOTAL = 0.6;

const STORAGE_KEY = 'workspace.layout.v1';

const PHONE_PANEL_KEY = 'workspace.phone-panel.v1';

const PANEL_NAMES: readonly WorkspacePanelName[] = ['files', 'editor', 'console', 'preview'];

export function clampFraction(value: number): number {
  return Math.min(MAX_FRACTION, Math.max(MIN_FRACTION, value));
}

export function clampLayout(layout: WorkspaceLayout, moved: ResizablePanel): WorkspaceLayout {
  const next = {
    ...layout,
    files: clampFraction(layout.files),
    preview: clampFraction(layout.preview),
    console: clampFraction(layout.console),
  };
  const excess = next.files + next.preview - MAX_SIDE_TOTAL;
  if (excess > 0 && moved !== 'console') {
    next[moved] = Math.max(MIN_FRACTION, next[moved] - excess);
  }
  return next;
}

export function isDefaultLayout(layout: WorkspaceLayout): boolean {
  return (
    layout.files === DEFAULT_LAYOUT.files &&
    layout.preview === DEFAULT_LAYOUT.preview &&
    layout.console === DEFAULT_LAYOUT.console &&
    !layout.collapsed.files &&
    !layout.collapsed.preview &&
    !layout.collapsed.console
  );
}

export function readStoredLayout(): WorkspaceLayout {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_LAYOUT;

    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return DEFAULT_LAYOUT;

    const candidate = parsed as Partial<WorkspaceLayout>;
    const collapsed: Partial<WorkspaceLayout['collapsed']> = candidate.collapsed ?? {};
    if (isPreviousDefault(candidate)) return DEFAULT_LAYOUT;

    return clampLayout(
      {
        files: numberOr(candidate.files, DEFAULT_LAYOUT.files),
        preview: numberOr(candidate.preview, DEFAULT_LAYOUT.preview),
        console: numberOr(candidate.console, DEFAULT_LAYOUT.console),
        collapsed: {
          files: collapsed.files === true,
          preview: collapsed.preview === true,
          console: collapsed.console === true,
        },
      },
      'preview',
    );
  } catch {
    return DEFAULT_LAYOUT;
  }
}

function isPreviousDefault(candidate: Partial<WorkspaceLayout>): boolean {
  const collapsed = candidate.collapsed;
  return (
    candidate.files === DEFAULT_LAYOUT.files &&
    candidate.preview === DEFAULT_LAYOUT.preview &&
    candidate.console === PREVIOUS_DEFAULT_CONSOLE &&
    collapsed?.files !== true &&
    collapsed?.preview !== true &&
    collapsed?.console !== true
  );
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? clampFraction(value) : fallback;
}

function readPhonePanel(): WorkspacePanelName {
  try {
    const raw = window.sessionStorage.getItem(PHONE_PANEL_KEY);
    return raw && (PANEL_NAMES as readonly string[]).includes(raw)
      ? (raw as WorkspacePanelName)
      : 'editor';
  } catch {
    return 'editor';
  }
}

export interface LayoutOptions {
  previewFramed?: boolean;
}

export interface LayoutControls {
  layout: WorkspaceLayout;
  isDefault: boolean;
  isMaximised: boolean;
  setFraction: (panel: ResizablePanel, value: number) => void;
  resetFraction: (panel: ResizablePanel) => void;
  toggle: (panel: ResizablePanel) => void;
  show: (panel: WorkspacePanelName) => void;
  toggleMaximise: () => void;
  reset: () => void;
  phonePanel: WorkspacePanelName;
  setPhonePanel: (panel: WorkspacePanelName) => void;
}

export function useWorkspaceLayout(options: LayoutOptions = {}): LayoutControls {
  const { previewFramed = false } = options;
  const [stored, setStored] = useState<WorkspaceLayout>(DEFAULT_LAYOUT);
  const [phonePanel, setPhonePanelState] = useState<WorkspacePanelName>('editor');

  const beforeMaximise = useRef<WorkspaceLayout['collapsed'] | undefined>(undefined);

  useEffect(() => {
    setStored(readStoredLayout());
    setPhonePanelState(readPhonePanel());
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
    } catch {}
  }, [stored]);

  const setFraction = useCallback((panel: ResizablePanel, value: number) => {
    setStored((current) => clampLayout({ ...current, [panel]: value }, panel));
  }, []);

  const resetFraction = useCallback((panel: ResizablePanel) => {
    setStored((current) => clampLayout({ ...current, [panel]: DEFAULT_LAYOUT[panel] }, panel));
  }, []);

  const toggle = useCallback((panel: ResizablePanel) => {
    beforeMaximise.current = undefined;
    setStored((current) => ({
      ...current,
      collapsed: { ...current.collapsed, [panel]: !current.collapsed[panel] },
    }));
  }, []);

  const setPhonePanel = useCallback((panel: WorkspacePanelName) => {
    setPhonePanelState(panel);
    try {
      window.sessionStorage.setItem(PHONE_PANEL_KEY, panel);
    } catch {}
  }, []);

  const show = useCallback(
    (panel: WorkspacePanelName) => {
      setPhonePanel(panel);
      if (panel === 'editor') return;
      setStored((current) =>
        current.collapsed[panel]
          ? { ...current, collapsed: { ...current.collapsed, [panel]: false } }
          : current,
      );
    },
    [setPhonePanel],
  );

  const toggleMaximise = useCallback(() => {
    setStored((current) => {
      const allHidden =
        current.collapsed.files && current.collapsed.console && current.collapsed.preview;
      if (allHidden) {
        const restored = beforeMaximise.current ?? DEFAULT_LAYOUT.collapsed;
        beforeMaximise.current = undefined;
        return { ...current, collapsed: restored };
      }
      beforeMaximise.current = current.collapsed;
      return { ...current, collapsed: { files: true, console: true, preview: true } };
    });
  }, []);

  const reset = useCallback(() => {
    beforeMaximise.current = undefined;
    setStored(DEFAULT_LAYOUT);
  }, []);

  const isDefault = isDefaultLayout(stored);
  const isMaximised =
    stored.collapsed.files && stored.collapsed.console && stored.collapsed.preview;

  const layout = useMemo(
    () => (isDefault && previewFramed ? { ...stored, preview: FRAMED_PREVIEW_FRACTION } : stored),
    [stored, isDefault, previewFramed],
  );

  return {
    layout,
    isDefault,
    isMaximised,
    setFraction,
    resetFraction,
    toggle,
    show,
    toggleMaximise,
    reset,
    phonePanel,
    setPhonePanel,
  };
}
