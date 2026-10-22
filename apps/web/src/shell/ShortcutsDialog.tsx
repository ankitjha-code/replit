import type { ReactElement } from 'react';
import { Dialog, Kbd } from '../ui/index.js';

interface ShortcutGroup {
  title: string;
  items: Array<{ keys: string[]; action: string }>;
}

export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: 'Everywhere',
    items: [
      { keys: ['Mod', 'K'], action: 'Command palette' },
      { keys: ['?'], action: 'Keyboard shortcuts' },
    ],
  },
  {
    title: 'Workspace',
    items: [
      { keys: ['Mod', 'P'], action: 'Open a file' },
      { keys: ['Mod', 'S'], action: 'Save now' },
      { keys: ['Mod', 'Enter'], action: 'Run the app (starts the environment first if needed)' },
      { keys: ['Mod', 'Shift', 'Enter'], action: 'Stop the app' },
      { keys: ['Mod', 'Shift', 'R'], action: 'Restart the app' },
      { keys: ['Mod', '`'], action: 'Focus the terminal, or back to the editor' },
      { keys: ['Mod', 'Shift', '`'], action: 'New terminal' },
      { keys: ['Ctrl', 'B'], action: 'Show or hide Files' },
      { keys: ['Ctrl', 'J'], action: 'Show or hide the Console' },
      { keys: ['Ctrl', 'Shift', 'V'], action: 'Show or hide the Preview' },
      { keys: ['Ctrl', 'Shift', 'M'], action: 'Maximise the editor' },
      { keys: ['Mod', 'W'], action: 'Close the tab' },
      { keys: ['Ctrl', 'Tab'], action: 'Next tab' },
      { keys: ['Ctrl', 'Shift', 'F'], action: 'Search files' },
    ],
  },
  {
    title: 'Files',
    items: [
      { keys: ['F2'], action: 'Rename' },
      { keys: ['Delete'], action: 'Delete' },
      { keys: ['↑', '↓', '←', '→'], action: 'Move through the tree' },
    ],
  },
];

export function ShortcutsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): ReactElement {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Keyboard shortcuts"
      description="Shortcuts are ignored while you type in a field, except Save and Run."
      size="md"
    >
      <div className="shortcuts">
        {SHORTCUT_GROUPS.map((group) => (
          <section key={group.title} className="shortcuts__group">
            <h3 className="shortcuts__title">{group.title}</h3>
            <dl className="shortcuts__list">
              {group.items.map((item) => (
                <div key={item.action} className="shortcuts__row">
                  <dt className="shortcuts__action">{item.action}</dt>
                  <dd className="shortcuts__keys">
                    <Kbd keys={item.keys} />
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Dialog>
  );
}
