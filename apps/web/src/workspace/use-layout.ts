import { useCallback, useEffect, useState } from 'react';

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

export const DEFAULT_LAYOUT: WorkspaceLayout = {
  files: 0.18,
  preview: 0.32,
  console: 0.28,
  collapsed: { files: false, preview: false, console: false },
};

/**
 * Floors below which a panel is too small to be useful.
 *
 * Dragging past one collapses rather than leaving a sliver: a two-pixel
 * editor is worse than a hidden one, and the reopen control stays visible.
 */
export const MIN_FRACTION = 0.12;
export const MAX_FRACTION = 0.6;

/**
 * One layout for the whole account, not one per project.
 *
 * Someone who widens the editor means it for how they work, not for one
 * particular project.
 */
const STORAGE_KEY = 'workspace.layout.v1';

export function clampFraction(value: number): number {
  return Math.min(MAX_FRACTION, Math.max(MIN_FRACTION, value));
}

/**
 * Reads a saved layout.
 *
 * Every access is guarded: storage throws outright in some privacy modes, and
 * a workspace that will not render because a preference could not be read
 * would be a poor trade.
 */
function readStored(): WorkspaceLayout {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_LAYOUT;

    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return DEFAULT_LAYOUT;

    const candidate = parsed as Partial<WorkspaceLayout>;
    const collapsed: Partial<WorkspaceLayout['collapsed']> = candidate.collapsed ?? {};

    // Each field is validated on its own. A stored layout may predate a change
    // to this shape, and one unrecognised key should not discard the rest.
    return {
      files: numberOr(candidate.files, DEFAULT_LAYOUT.files),
      preview: numberOr(candidate.preview, DEFAULT_LAYOUT.preview),
      console: numberOr(candidate.console, DEFAULT_LAYOUT.console),
      collapsed: {
        files: collapsed.files === true,
        preview: collapsed.preview === true,
        console: collapsed.console === true,
      },
    };
  } catch {
    return DEFAULT_LAYOUT;
  }
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? clampFraction(value) : fallback;
}

export interface LayoutControls {
  layout: WorkspaceLayout;
  setFraction: (panel: 'files' | 'preview' | 'console', value: number) => void;
  toggle: (panel: 'files' | 'preview' | 'console') => void;
  reset: () => void;
}

export function useWorkspaceLayout(): LayoutControls {
  const [layout, setLayout] = useState<WorkspaceLayout>(DEFAULT_LAYOUT);

  // Read after mount rather than during initialisation: the first render must
  // match what a server would produce, and storage is not available there.
  useEffect(() => {
    setLayout(readStored());
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
    } catch {
      // A layout that cannot be remembered is a small loss. Failing the render
      // over it would be a large one.
    }
  }, [layout]);

  const setFraction = useCallback((panel: 'files' | 'preview' | 'console', value: number) => {
    setLayout((current) => ({ ...current, [panel]: clampFraction(value) }));
  }, []);

  const toggle = useCallback((panel: 'files' | 'preview' | 'console') => {
    setLayout((current) => ({
      ...current,
      collapsed: { ...current.collapsed, [panel]: !current.collapsed[panel] },
    }));
  }, []);

  const reset = useCallback(() => setLayout(DEFAULT_LAYOUT), []);

  return { layout, setFraction, toggle, reset };
}
