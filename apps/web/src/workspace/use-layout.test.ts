import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_LAYOUT,
  FRAMED_PREVIEW_FRACTION,
  MAX_FRACTION,
  MAX_SIDE_TOTAL,
  MIN_FRACTION,
  clampLayout,
  isDefaultLayout,
  readStoredLayout,
  useWorkspaceLayout,
} from './use-layout.js';

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe('clampLayout', () => {
  it('keeps each panel between its floor and ceiling', () => {
    const clamped = clampLayout({ ...DEFAULT_LAYOUT, files: 0.01, console: 0.99 }, 'console');
    expect(clamped.files).toBe(MIN_FRACTION);
    expect(clamped.console).toBe(MAX_FRACTION);
  });

  it('shrinks the panel being moved so files and preview never crowd out the editor', () => {
    const clamped = clampLayout({ ...DEFAULT_LAYOUT, files: 0.4, preview: 0.5 }, 'preview');
    expect(clamped.files + clamped.preview).toBeLessThanOrEqual(MAX_SIDE_TOTAL);
    expect(clamped.files).toBe(0.4);
    expect(clamped.preview).toBeCloseTo(MAX_SIDE_TOTAL - 0.4);
  });

  it('never shrinks the moved panel below its floor to make room', () => {
    const clamped = clampLayout({ ...DEFAULT_LAYOUT, files: 0.6, preview: 0.6 }, 'files');
    expect(clamped.files).toBe(MIN_FRACTION);
  });
});

describe('isDefaultLayout', () => {
  it('is true only when nothing moved and nothing is hidden', () => {
    expect(isDefaultLayout(DEFAULT_LAYOUT)).toBe(true);
    expect(isDefaultLayout({ ...DEFAULT_LAYOUT, files: 0.2 })).toBe(false);
    expect(
      isDefaultLayout({
        ...DEFAULT_LAYOUT,
        collapsed: { ...DEFAULT_LAYOUT.collapsed, files: true },
      }),
    ).toBe(false);
  });
});

describe('readStoredLayout', () => {
  it('fills in fields a stored layout from an older shape is missing', () => {
    window.localStorage.setItem('workspace.layout.v1', JSON.stringify({ files: 0.3 }));
    const layout = readStoredLayout();
    expect(layout.files).toBe(0.3);
    expect(layout.preview).toBe(DEFAULT_LAYOUT.preview);
    expect(layout.collapsed).toEqual(DEFAULT_LAYOUT.collapsed);
  });

  it('moves an untouched layout saved under the old default to the current one', () => {
    window.localStorage.setItem(
      'workspace.layout.v1',
      JSON.stringify({
        files: 0.16,
        preview: 0.22,
        console: 0.28,
        collapsed: { files: false, preview: false, console: false },
      }),
    );
    expect(readStoredLayout()).toEqual(DEFAULT_LAYOUT);
    expect(isDefaultLayout(readStoredLayout())).toBe(true);
  });

  it('keeps an old console height that comes with other changes the person made', () => {
    window.localStorage.setItem(
      'workspace.layout.v1',
      JSON.stringify({
        files: 0.2,
        preview: 0.22,
        console: 0.28,
        collapsed: { files: false, preview: false, console: false },
      }),
    );
    expect(readStoredLayout().console).toBe(0.28);
  });

  it('gives the console a third of the height by default, so a shell has room', () => {
    expect(DEFAULT_LAYOUT.console).toBeGreaterThanOrEqual(0.33);
  });

  it('falls back to the default for anything unusable', () => {
    window.localStorage.setItem('workspace.layout.v1', '[1,2,3]');
    expect(readStoredLayout()).toEqual(DEFAULT_LAYOUT);
    window.localStorage.setItem('workspace.layout.v1', 'not json');
    expect(readStoredLayout()).toEqual(DEFAULT_LAYOUT);
  });
});

describe('useWorkspaceLayout', () => {
  it('reports isDefault and flips it after any change, then back after reset', () => {
    const { result } = renderHook(() => useWorkspaceLayout());
    expect(result.current.isDefault).toBe(true);

    act(() => result.current.toggle('console'));
    expect(result.current.isDefault).toBe(false);
    expect(result.current.layout.collapsed.console).toBe(true);

    act(() => result.current.reset());
    expect(result.current.isDefault).toBe(true);
  });

  it('widens the preview for a framed app only while the layout is the default', () => {
    const { result, rerender } = renderHook(
      ({ framed }: { framed: boolean }) => useWorkspaceLayout({ previewFramed: framed }),
      { initialProps: { framed: false } },
    );
    expect(result.current.layout.preview).toBe(DEFAULT_LAYOUT.preview);

    rerender({ framed: true });
    expect(result.current.layout.preview).toBe(FRAMED_PREVIEW_FRACTION);
    expect(result.current.isDefault).toBe(true);

    act(() => result.current.setFraction('preview', 0.15));
    expect(result.current.layout.preview).toBe(0.15);
    expect(result.current.isDefault).toBe(false);
  });

  it('maximises the editor and restores exactly what was hidden before', () => {
    const { result } = renderHook(() => useWorkspaceLayout());
    act(() => result.current.toggle('files'));

    act(() => result.current.toggleMaximise());
    expect(result.current.isMaximised).toBe(true);
    expect(result.current.layout.collapsed).toEqual({ files: true, console: true, preview: true });

    act(() => result.current.toggleMaximise());
    expect(result.current.isMaximised).toBe(false);
    expect(result.current.layout.collapsed).toEqual({
      files: true,
      console: false,
      preview: false,
    });
  });

  it('show() expands a hidden panel and makes it the phone panel', () => {
    const { result } = renderHook(() => useWorkspaceLayout());
    act(() => result.current.toggle('preview'));
    expect(result.current.layout.collapsed.preview).toBe(true);

    act(() => result.current.show('preview'));
    expect(result.current.layout.collapsed.preview).toBe(false);
    expect(result.current.phonePanel).toBe('preview');
    expect(window.sessionStorage.getItem('workspace.phone-panel.v1')).toBe('preview');
  });

  it('remembers the layout in storage and reads it back', () => {
    const first = renderHook(() => useWorkspaceLayout());
    act(() => first.result.current.setFraction('files', 0.3));
    first.unmount();

    const second = renderHook(() => useWorkspaceLayout());
    expect(second.result.current.layout.files).toBe(0.3);
  });
});
