import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorSettingsDialog } from './EditorSettingsDialog.js';
import {
  DEFAULT_EDITOR_SETTINGS,
  EDITOR_SETTINGS_KEY,
  adjustEditorFontSize,
  getEditorSettings,
  resetEditorSettingsCache,
} from './editor-settings.js';

beforeEach(() => {
  window.localStorage.clear();
  resetEditorSettingsCache();
});

afterEach(() => {
  window.localStorage.clear();
  resetEditorSettingsCache();
});

describe('editor settings', () => {
  it('shows the stored values and applies a change at once', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(<EditorSettingsDialog open onOpenChange={onOpenChange} />);

    expect(screen.getByRole('dialog', { name: 'Editor settings' })).toBeInTheDocument();
    expect(screen.getByLabelText('Font size')).toHaveValue('13');

    await user.selectOptions(screen.getByLabelText('Font size'), '16');
    expect(getEditorSettings().fontSize).toBe(16);
    expect(JSON.parse(window.localStorage.getItem(EDITOR_SETTINGS_KEY) ?? '{}')).toMatchObject({
      fontSize: 16,
    });

    await user.click(screen.getByRole('switch', { name: 'Word wrap' }));
    expect(getEditorSettings().wordWrap).toBe(false);

    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('resets to the defaults', async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(
      EDITOR_SETTINGS_KEY,
      JSON.stringify({ fontSize: 18, minimap: true, tabSize: 4 }),
    );
    render(<EditorSettingsDialog open onOpenChange={() => {}} />);

    expect(screen.getByLabelText('Font size')).toHaveValue('18');
    expect(screen.getByRole('switch', { name: 'Minimap' })).toBeChecked();

    await user.click(screen.getByRole('button', { name: 'Reset to defaults' }));
    expect(getEditorSettings()).toEqual(DEFAULT_EDITOR_SETTINGS);
    expect(screen.getByLabelText('Font size')).toHaveValue('13');
  });

  it('ignores an unusable stored value and keeps the font size within range', () => {
    window.localStorage.setItem(EDITOR_SETTINGS_KEY, '{"fontSize":"huge","tabSize":3}');
    expect(getEditorSettings()).toEqual(DEFAULT_EDITOR_SETTINGS);

    adjustEditorFontSize(+40);
    expect(getEditorSettings().fontSize).toBe(18);
    adjustEditorFontSize(-40);
    expect(getEditorSettings().fontSize).toBe(11);
  });
});
