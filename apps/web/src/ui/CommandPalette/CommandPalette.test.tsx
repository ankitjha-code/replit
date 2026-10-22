import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Play, Stop } from '../icons.js';
import { CommandPalette, type CommandPaletteProps } from './CommandPalette.js';

const commands = [
  {
    id: 'run',
    label: 'Run app',
    icon: Play,
    shortcut: ['Mod', 'Enter'],
    group: 'App',
    onSelect: vi.fn(),
  },
  {
    id: 'stop',
    label: 'Stop app',
    icon: Stop,
    group: 'App',
    onSelect: vi.fn(),
    disabledReason: 'Nothing is running',
  },
  { id: 'theme', label: 'Theme: Light', group: 'Appearance', onSelect: vi.fn() },
];

function renderPalette(props: Partial<CommandPaletteProps> = {}) {
  const onOpenChange = vi.fn();
  render(<CommandPalette open onOpenChange={onOpenChange} commands={commands} {...props} />);
  return { onOpenChange };
}

describe('CommandPalette', () => {
  it('filters commands, moves with the arrow keys and runs on Enter', async () => {
    const { onOpenChange } = renderPalette({ recent: ['theme'] });
    const input = screen.getByRole('combobox', { name: 'Search commands' });
    expect(input).toHaveFocus();
    expect(screen.getByText('Recent')).toBeInTheDocument();
    expect(screen.getAllByRole('option')[0]).toHaveTextContent('Theme: Light');

    await userEvent.type(input, 'app');
    const options = screen.getAllByRole('option');
    expect(options.map((option) => option.textContent)).toEqual([
      expect.stringContaining('Run app'),
      expect.stringContaining('Stop app'),
    ]);
    expect(options[1]).toHaveAttribute('aria-disabled', 'true');
    expect(options[1]).toHaveTextContent('Nothing is running');

    await userEvent.keyboard('{Enter}');
    expect(commands[0]?.onSelect).toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('does not run a disabled command', async () => {
    const { onOpenChange } = renderPalette();
    await userEvent.type(screen.getByRole('combobox'), 'stop');
    await userEvent.keyboard('{Enter}');
    expect(commands[1]?.onSelect).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it('switches to files with > and offers to create when nothing matches', async () => {
    const onFileQuery = vi.fn();
    const onOpenFile = vi.fn();
    const onCreateFile = vi.fn();
    renderPalette({
      files: { status: 'ready', items: [{ path: 'src/index.ts' }, { path: 'README.md' }] },
      onFileQuery,
      onOpenFile,
      onCreateFile,
    });
    const input = screen.getByRole('combobox');
    await userEvent.type(input, '>ind');
    expect(onFileQuery).toHaveBeenLastCalledWith('ind');
    expect(screen.getByRole('combobox', { name: 'Search files' })).toBeInTheDocument();
    expect(screen.getAllByRole('option')).toHaveLength(1);
    await userEvent.keyboard('{Enter}');
    expect(onOpenFile).toHaveBeenCalledWith('src/index.ts');

    await userEvent.clear(input);
    await userEvent.type(input, '>nothing.ts');
    expect(screen.getByRole('status')).toHaveTextContent('No files match "nothing.ts".');
    await userEvent.click(screen.getByRole('button', { name: 'Create "nothing.ts"' }));
    expect(onCreateFile).toHaveBeenCalledWith('nothing.ts');
  });

  it('shows the file search error with a retry', () => {
    const retry = vi.fn();
    renderPalette({
      mode: 'files',
      files: { status: 'error', items: [], error: 'Search failed', retry },
    });
    expect(screen.getByRole('alert')).toHaveTextContent('Search failed');
    screen.getByRole('button', { name: 'Retry' }).click();
    expect(retry).toHaveBeenCalled();
  });
});
