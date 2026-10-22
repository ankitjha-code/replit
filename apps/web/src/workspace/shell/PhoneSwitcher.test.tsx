import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { PhoneSwitcher } from './PhoneSwitcher.js';

describe('PhoneSwitcher', () => {
  it('is a tab list naming the four regions, with the active one selected', () => {
    render(<PhoneSwitcher active="console" onChange={() => undefined} />);

    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((tab) => tab.textContent)).toEqual(['Files', 'Editor', 'Console', 'Preview']);
    expect(screen.getByRole('tab', { name: 'Console' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Files' })).toHaveAttribute('aria-selected', 'false');
  });

  it('switches on click and with the arrow keys', async () => {
    const onChange = vi.fn();
    render(<PhoneSwitcher active="editor" onChange={onChange} />);

    await userEvent.click(screen.getByRole('tab', { name: 'Preview' }));
    expect(onChange).toHaveBeenLastCalledWith('preview');

    screen.getByRole('tab', { name: 'Editor' }).focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(onChange).toHaveBeenLastCalledWith('console');
    await userEvent.keyboard('{End}');
    expect(onChange).toHaveBeenLastCalledWith('preview');
  });

  it('marks unsaved changes on Editor and a running app on Console, in words too', () => {
    render(<PhoneSwitcher active="editor" onChange={() => undefined} dirty running />);

    expect(screen.getByRole('tab', { name: /Editor, unsaved changes/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Console, app running/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Files' })).toBeInTheDocument();
  });
});
