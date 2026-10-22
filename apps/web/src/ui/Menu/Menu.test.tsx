import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { Button } from '../Button/Button.js';
import { Trash } from '../icons.js';
import { ContextMenu } from './ContextMenu.js';
import { Menu } from './Menu.js';

describe('Menu', () => {
  it('opens from its trigger, runs an item, and links and disables with a reason', async () => {
    const onRename = vi.fn();
    render(
      <MemoryRouter>
        <Menu
          trigger={<Button>Actions</Button>}
          items={[
            { label: 'Rename', shortcut: ['F2'], onSelect: onRename },
            { label: 'Settings', to: '/settings' },
            {
              label: 'Delete',
              icon: Trash,
              tone: 'danger',
              disabledReason: 'Only the owner can delete',
            },
          ]}
        />
      </MemoryRouter>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Actions' }));
    const menu = await screen.findByRole('menu');
    expect(menu).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /Settings/ })).toHaveAttribute('href', '/settings');
    const del = screen.getByRole('menuitem', { name: /Delete/ });
    expect(del).toHaveAttribute('aria-disabled', 'true');
    expect(del).toHaveTextContent('Only the owner can delete');

    await userEvent.click(screen.getByRole('menuitem', { name: /Rename/ }));
    expect(onRename).toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  });

  it('renders groups, checkbox items and a radio group', async () => {
    const onValueChange = vi.fn();
    render(
      <Menu
        trigger={<Button>View</Button>}
        groups={[{ label: 'Panels', items: [{ label: 'Files', checked: true }] }]}
        radio={{
          label: 'Theme',
          value: 'dark',
          onValueChange,
          items: [
            { value: 'dark', label: 'Dark' },
            { value: 'light', label: 'Light' },
          ],
        }}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'View' }));
    await screen.findByRole('menu');
    expect(screen.getByRole('menuitemcheckbox', { name: 'Files' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByRole('menuitemradio', { name: 'Dark' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await userEvent.click(screen.getByRole('menuitemradio', { name: 'Light' }));
    expect(onValueChange).toHaveBeenCalledWith('light');
  });
});

describe('focus after a menu closes', () => {
  it('lets an item put focus somewhere other than the trigger', async () => {
    // A menu item that opens an inline field must not lose it to the trigger.
    function Harness(): React.JSX.Element {
      return (
        <>
          <Menu
            trigger={<Button>Actions</Button>}
            items={[{ label: 'Rename', onSelect: () => undefined }]}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              document.getElementById('field')?.focus();
            }}
          />
          <input id="field" aria-label="Field" />
        </>
      );
    }
    render(<Harness />);
    await userEvent.click(screen.getByRole('button', { name: 'Actions' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Rename' }));
    await waitFor(() => expect(screen.getByLabelText('Field')).toHaveFocus());
  });

  it('passes the same through on a context menu', async () => {
    const onCloseAutoFocus = vi.fn((event: Event) => event.preventDefault());
    render(
      <ContextMenu items={[{ label: 'New file' }]} onCloseAutoFocus={onCloseAutoFocus}>
        <div>Tree</div>
      </ContextMenu>,
    );
    await userEvent.pointer({ keys: '[MouseRight]', target: screen.getByText('Tree') });
    await userEvent.click(await screen.findByRole('menuitem', { name: 'New file' }));
    await waitFor(() => expect(onCloseAutoFocus).toHaveBeenCalled());
  });
});

describe('ContextMenu', () => {
  it('opens on right-click over its area', async () => {
    const onSelect = vi.fn();
    render(
      <ContextMenu items={[{ label: 'New file', onSelect }]}>
        <div>Tree</div>
      </ContextMenu>,
    );
    await userEvent.pointer({ keys: '[MouseRight]', target: screen.getByText('Tree') });
    await userEvent.click(await screen.findByRole('menuitem', { name: 'New file' }));
    expect(onSelect).toHaveBeenCalled();
  });
});
