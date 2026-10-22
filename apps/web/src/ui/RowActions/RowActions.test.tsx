import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { DownloadSimple, Gear, PencilSimple, Trash, ArrowClockwise } from '../icons.js';
import { RowActions, rowActionName } from './RowActions.js';

describe('RowActions', () => {
  it('names every action after the row and shows up to two inline', () => {
    const onRename = vi.fn();
    render(
      <RowActions
        objectName="alice"
        items={[
          { label: 'Rename', icon: PencilSimple, onSelect: onRename },
          {
            label: 'Remove',
            icon: Trash,
            tone: 'danger',
            disabledReason: 'You cannot remove the owner',
          },
        ]}
      />,
    );
    expect(rowActionName('Remove', 'alice')).toBe('Remove alice');
    expect(screen.getByRole('button', { name: 'Rename alice' })).toBeEnabled();
    const remove = screen.getByRole('button', { name: 'Remove alice' });
    expect(remove).toBeDisabled();
    expect(remove).toHaveAccessibleDescription('You cannot remove the owner');
  });

  it('moves more than two actions into a menu named after the row', async () => {
    const onRestart = vi.fn();
    render(
      <RowActions
        objectName="deploy-42"
        items={[
          { label: 'Restart', icon: ArrowClockwise, onSelect: onRestart },
          { label: 'Rename', icon: PencilSimple, onSelect: () => {} },
          { label: 'Remove', icon: Trash, onSelect: () => {} },
        ]}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Restart deploy-42' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Actions for deploy-42' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Restart deploy-42' }));
    expect(onRestart).toHaveBeenCalled();
  });

  it('renders an inline action with a destination as a link named after the row', async () => {
    render(
      <MemoryRouter>
        <RowActions
          objectName="notes.txt"
          items={[
            {
              label: 'Download',
              icon: DownloadSimple,
              href: '/api/files/notes.txt',
              download: 'notes.txt',
            },
            { label: 'Settings for', icon: Gear, to: '/projects/p/settings' },
          ]}
        />
      </MemoryRouter>,
    );
    const download = screen.getByRole('link', { name: 'Download notes.txt' });
    expect(download).toHaveAttribute('href', '/api/files/notes.txt');
    expect(download).toHaveAttribute('download', 'notes.txt');
    expect(download).toHaveClass('ui-button', 'ui-button--icon');
    expect(screen.getByRole('link', { name: 'Settings for notes.txt' })).toHaveAttribute(
      'href',
      '/projects/p/settings',
    );

    await userEvent.hover(download);
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Download notes.txt');
  });

  it('keeps a link action in the overflow menu as a link', async () => {
    render(
      <MemoryRouter>
        <RowActions
          objectName="notes.txt"
          items={[
            { label: 'Download', icon: DownloadSimple, href: '/files/notes.txt', download: true },
            { label: 'Rename', icon: PencilSimple, onSelect: () => {} },
            { label: 'Remove', icon: Trash, onSelect: () => {} },
          ]}
        />
      </MemoryRouter>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Actions for notes.txt' }));
    const item = await screen.findByRole('menuitem', { name: 'Download notes.txt' });
    expect(item).toHaveAttribute('href', '/files/notes.txt');
    expect(item).toHaveAttribute('download', '');
  });
});
