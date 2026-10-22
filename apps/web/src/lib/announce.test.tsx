import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnnounceContext, useAnnounce, writeLiveRegion } from './announce.js';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('useAnnounce', () => {
  it('writes through the nearest provider', () => {
    const provided = vi.fn();
    const { result } = renderHook(() => useAnnounce(), {
      wrapper: ({ children }) => (
        <AnnounceContext.Provider value={provided}>{children}</AnnounceContext.Provider>
      ),
    });
    result.current('Environment is running');
    expect(provided).toHaveBeenCalledWith('Environment is running', 'polite');
    result.current('App exited with code 1', 'assertive');
    expect(provided).toHaveBeenCalledWith('App exited with code 1', 'assertive');
  });

  it('creates a document-level region when there is no provider', () => {
    const { result } = renderHook(() => useAnnounce());
    result.current('Saved');
    vi.runAllTimers();
    const region = document.getElementById('live-region-polite');
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region).toHaveTextContent('Saved');

    result.current('Saved');
    vi.runAllTimers();
    expect(document.querySelectorAll('[aria-live="polite"]')).toHaveLength(1);
  });
});

describe('writeLiveRegion', () => {
  it('empties the region before writing so a repeat is read again', () => {
    const region = document.createElement('div');
    region.textContent = 'Saved';
    writeLiveRegion(region, 'Saved');
    expect(region.textContent).toBe('');
    vi.runAllTimers();
    expect(region.textContent).toBe('Saved');
  });
});
