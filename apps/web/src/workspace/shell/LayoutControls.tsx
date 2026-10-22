import type { ReactElement } from 'react';
import { Button, Menu, type MenuItem } from '../../ui/index.js';
import { Keyboard, SidebarSimple } from '../../ui/icons.js';
import type { LayoutControls as LayoutState } from '../use-layout.js';

/**
 * The Layout menu and, beside it, "Reset layout" (design spec 9.1).
 *
 * The menu's items flip between "Hide files" and "Show files" so they read as
 * the next action. They are checkbox menu items, a different role from the
 * panel headers' buttons of the same names, so neither locator is ambiguous.
 * "Reset layout" is always rendered: disabled with a reason when there is
 * nothing to reset, enabled the moment anything moved.
 */

export const LAYOUT_DEFAULT_REASON = 'Layout is already the default';

export function LayoutControls({
  layout,
  onShowShortcuts,
}: {
  layout: LayoutState;
  onShowShortcuts: () => void;
}): ReactElement {
  const { collapsed } = layout.layout;
  const items: MenuItem[] = [
    {
      id: 'files',
      label: collapsed.files ? 'Show files' : 'Hide files',
      checked: !collapsed.files,
      shortcut: ['Ctrl', 'B'],
      onSelect: () => layout.toggle('files'),
    },
    {
      id: 'console',
      label: collapsed.console ? 'Show console' : 'Hide console',
      checked: !collapsed.console,
      shortcut: ['Ctrl', 'J'],
      onSelect: () => layout.toggle('console'),
    },
    {
      id: 'preview',
      label: collapsed.preview ? 'Show preview' : 'Hide preview',
      checked: !collapsed.preview,
      shortcut: ['Ctrl', 'Shift', 'V'],
      onSelect: () => layout.toggle('preview'),
    },
  ];

  return (
    <div className="layout-controls">
      <Menu
        align="end"
        trigger={
          <Button variant="ghost" size="sm" icon={SidebarSimple} className="ws-toolbar__layout">
            Layout
          </Button>
        }
        groups={[
          { items },
          {
            items: [
              {
                id: 'maximise',
                label: layout.isMaximised ? 'Restore panels' : 'Maximise editor',
                shortcut: ['Ctrl', 'Shift', 'M'],
                onSelect: layout.toggleMaximise,
              },
            ],
          },
          {
            items: [
              {
                id: 'shortcuts',
                label: 'Keyboard shortcuts',
                icon: Keyboard,
                shortcut: ['?'],
                onSelect: onShowShortcuts,
              },
            ],
          },
        ]}
      />
      <Button
        variant="ghost"
        size="sm"
        className="ws-toolbar__reset"
        onClick={layout.reset}
        {...(layout.isDefault ? { disabledReason: LAYOUT_DEFAULT_REASON } : {})}
      >
        Reset layout
      </Button>
    </div>
  );
}
