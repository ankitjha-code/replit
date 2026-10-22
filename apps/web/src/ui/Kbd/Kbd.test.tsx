import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Kbd, shortcutLabel } from './Kbd.js';

afterEach(() => vi.restoreAllMocks());

describe('Kbd', () => {
  it('spells Mod as Ctrl off Apple platforms', () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Win32');
    render(<Kbd keys={['Mod', 'K']} />);
    expect(screen.getByText('Ctrl')).toBeInTheDocument();
    expect(screen.getByLabelText('Ctrl+K')).toBeInTheDocument();
  });

  it('spells Mod as Command on Apple platforms', () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
    expect(shortcutLabel(['Mod', 'Shift', 'P'])).toBe('⌘⇧P');
  });
});
