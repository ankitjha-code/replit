import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { WorkspacePanelName } from './shell/workspace-actions.js';

/**
 * Workspace panel sizes.
 *
 * Sizes are fractions of the available axis rather than pixels, so a layout
 * arranged on a large display still makes sense on a small one. Storing pixels
 * would leave someone with a 900px editor on a 1000px screen.
 */
export interface WorkspaceLayout {
  /** Share of the width taken by the file explorer. */
  files: number;
  /** Share of the width taken by the preview. */
  preview: number;
  /** Share of the height taken by the console. */
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
  // Over a third of the height, so a shell shows nine rows on a 720px window
  // and twelve on a 900px one: fewer and the output of one command scrolls the
  // command away.
  console: 0.36,
  collapsed: { files: false, preview: false, console: false },
};

/**
 * The console height the default used to have.
 *
 * Every visit stores the layout, so a person who never touched it has the old
 * default saved. Read back as it is, it would keep them on the short console
 * and light up "Reset layout" for a change they did not make.
 */
const PREVIOUS_DEFAULT_CONSOLE = 0.28;

/** The preview's width while an application is framed (design spec 9.9). */
export const FRAMED_PREVIEW_FRACTION = 0.32;

/**
 * Floors below which a panel is too small to be useful.
 *
 * Dragging past one collapses rather than leaving a sliver: a two-pixel
 * editor is worse than a hidden one, and the reopen control stays visible.
 */
export const MIN_FRACTION = 0.12;
export const MAX_FRACTION = 0.6;

/**
 * Files and preview together never take more than this, so the editor keeps
 * at least 40% of the width however the two side panels are dragged.
 */
export const MAX_SIDE_TOTAL = 0.6;

/**
 * One layout for the whole account, not one per project.
 *
 * Someone who widens the editor means it for how they work, not for one
 * particular project.
 */
const STORAGE_KEY = 'workspace.layout.v1';

/** Which panel a phone shows; per tab, because it is about this screen, not the account. */
const PHONE_PANEL_KEY = 'workspace.phone-panel.v1';

const PANEL_NAMES: readonly WorkspacePanelName[] = ['files', 'editor', 'console', 'preview'];

export function clampFraction(value: number): number {
  return Math.min(MAX_FRACTION, Math.max(MIN_FRACTION, value));
}

/**
 * Applies both clamps: the panel's own floor and ceiling, then the combined
 * ceiling on the two side panels, which shrinks the one being moved rather
 * than the other, so the editor never drops below 40%.
 */
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

/**
 * Reads a saved layout.
 *
 * Every access is guarded: storage throws outright in some privacy modes, and
 * a workspace that will not render because a preference could not be read
 * would be a poor trade.
 */
export function readStoredLayout(): WorkspaceLayout {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_LAYOUT;

    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return DEFAULT_LAYOUT;

    const candidate = parsed as Partial<WorkspaceLayout>;
    const collapsed: Partial<WorkspaceLayout['collapsed']> = candidate.collapsed ?? {};
    if (isPreviousDefault(candidate)) return DEFAULT_LAYOUT;

    // Each field is validated on its own. A stored layout may predate a change
    // to this shape, and one unrecognised key should not discard the rest.
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
  /**
   * An application is listening and the browser can frame it. While the
   * stored layout is the default, the preview widens to show it; a layout the
   * person has touched is left alone.
   */
  previewFramed?: boolean;
}

export interface LayoutControls {
  /** What to render: the stored layout, or the state-aware default. */
  layout: WorkspaceLayout;
  /** True when nothing has been moved or hidden, so "Reset layout" has nothing to do. */
  isDefault: boolean;
  /** True while Files, Console and Preview are all hidden. */
  isMaximised: boolean;
  setFraction: (panel: ResizablePanel, value: number) => void;
  /** Puts one panel's size back to its default. */
  resetFraction: (panel: ResizablePanel) => void;
  toggle: (panel: ResizablePanel) => void;
  /** Expands a collapsed panel; on a phone, also switches to it. */
  show: (panel: WorkspacePanelName) => void;
  /** Hides the three side panels, or brings back what was hidden by the last call. */
  toggleMaximise: () => void;
  reset: () => void;
  /** The one panel a phone shows. */
  phonePanel: WorkspacePanelName;
  setPhonePanel: (panel: WorkspacePanelName) => void;
}

export function useWorkspaceLayout(options: LayoutOptions = {}): LayoutControls {
  const { previewFramed = false } = options;
  const [stored, setStored] = useState<WorkspaceLayout>(DEFAULT_LAYOUT);
  const [phonePanel, setPhonePanelState] = useState<WorkspacePanelName>('editor');

  /** What was collapsed before "Maximise editor", so the second press restores it. */
  const beforeMaximise = useRef<WorkspaceLayout['collapsed'] | undefined>(undefined);

  // Read after mount rather than during initialisation: the first render must
  // match what a server would produce, and storage is not available there.
  useEffect(() => {
    setStored(readStoredLayout());
    setPhonePanelState(readPhonePanel());
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
    } catch {
      // A layout that cannot be remembered is a small loss. Failing the render
      // over it would be a large one.
    }
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
    } catch {
      // Same trade as the layout itself.
    }
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

  // The state-aware default applies only while the person has not arranged
  // anything: a manual size or a collapse wins until Reset layout.
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
