import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GALLERY_SECTIONS, Gallery } from './Gallery.js';
import { clearToasts } from './Toast/Toast.js';
import { UiProvider } from './UiProvider/UiProvider.js';

/*
 * Every primitive, every state, under both themes, with no React warnings.
 * The overlays (dialog, confirm, palette, menu, popover) open one at a time.
 */

const themes = ['dark', 'light'] as const;

function renderGallery() {
  return render(
    <MemoryRouter>
      <UiProvider>
        <Gallery />
      </UiProvider>
    </MemoryRouter>,
  );
}

describe('Gallery', () => {
  let errors: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    clearToasts();
    delete document.documentElement.dataset.theme;
    vi.restoreAllMocks();
  });

  for (const theme of themes) {
    it(`renders every section in the ${theme} theme without warnings`, () => {
      document.documentElement.dataset.theme = theme;
      renderGallery();
      for (const name of GALLERY_SECTIONS) {
        expect(screen.getByRole('region', { name })).toBeInTheDocument();
      }
      expect(document.documentElement.dataset.theme).toBe(theme);
      expect(errors).not.toHaveBeenCalled();
    });
  }

  it('opens each overlay from its section', async () => {
    renderGallery();

    await userEvent.click(screen.getByRole('button', { name: 'Open dialog' }));
    expect(await screen.findByRole('dialog', { name: 'Rename project' })).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Rename project' })).toBeNull(),
    );

    const confirms = within(screen.getByRole('region', { name: 'ConfirmDialog' }));
    await userEvent.click(confirms.getByRole('button', { name: 'Delete project' }));
    expect(await screen.findByRole('alertdialog', { name: 'Delete project?' })).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());

    await userEvent.click(screen.getByRole('button', { name: 'Open palette' }));
    expect(await screen.findByRole('combobox', { name: 'Search commands' })).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    await waitFor(() =>
      expect(screen.queryByRole('combobox', { name: 'Search commands' })).toBeNull(),
    );

    await userEvent.click(screen.getByRole('button', { name: 'Actions' }));
    expect(await screen.findByRole('menu')).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());

    const popovers = within(screen.getByRole('region', { name: 'Popover' }));
    await userEvent.click(popovers.getByRole('button', { name: 'Details' }));
    expect(await screen.findByRole('dialog', { name: 'Environment' })).toHaveTextContent('node 22');
    await userEvent.keyboard('{Escape}');

    await userEvent.click(screen.getByRole('button', { name: 'Danger (persists)' }));
    const notifications = within(screen.getByRole('region', { name: /Notifications/ }));
    expect(await notifications.findByText('Save failed')).toBeInTheDocument();
    expect(errors).not.toHaveBeenCalled();
  });
});
