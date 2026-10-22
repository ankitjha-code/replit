import { useRef, type KeyboardEvent, type ReactElement } from 'react';
import { Browser, Code, FolderSimple, TerminalWindow, type Icon } from '../../ui/icons.js';
import type { WorkspacePanelName } from './workspace-actions.js';

const PANELS: Array<{ name: WorkspacePanelName; label: string; icon: Icon }> = [
  { name: 'files', label: 'Files', icon: FolderSimple },
  { name: 'editor', label: 'Editor', icon: Code },
  { name: 'console', label: 'Console', icon: TerminalWindow },
  { name: 'preview', label: 'Preview', icon: Browser },
];

export function PhoneSwitcher({
  active,
  onChange,
  dirty = false,
  running = false,
}: {
  active: WorkspacePanelName;
  onChange: (panel: WorkspacePanelName) => void;
  dirty?: boolean;
  running?: boolean;
}): ReactElement {
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const index = PANELS.findIndex((panel) => panel.name === active);
    let next = index;
    if (event.key === 'ArrowRight') next = (index + 1) % PANELS.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + PANELS.length) % PANELS.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = PANELS.length - 1;
    else return;
    event.preventDefault();
    const panel = PANELS[next];
    if (!panel) return;
    onChange(panel.name);
    buttons.current[next]?.focus();
  };

  return (
    <div
      role="tablist"
      aria-label="Workspace panels"
      className="phone-switcher"
      onKeyDown={onKeyDown}
    >
      {PANELS.map((panel, index) => {
        const selected = panel.name === active;
        const dot = (panel.name === 'editor' && dirty) || (panel.name === 'console' && running);
        const dotLabel =
          panel.name === 'editor'
            ? 'unsaved changes'
            : panel.name === 'console'
              ? 'app running'
              : '';
        const PanelIcon = panel.icon;
        return (
          <button
            key={panel.name}
            ref={(element) => {
              buttons.current[index] = element;
            }}
            type="button"
            role="tab"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            className={`phone-switcher__tab${selected ? ' phone-switcher__tab--active' : ''}`}
            onClick={() => onChange(panel.name)}
          >
            <span className="phone-switcher__icon">
              <PanelIcon size={20} aria-hidden="true" />
              {dot ? (
                <span
                  className={`phone-switcher__dot phone-switcher__dot--${panel.name}`}
                  aria-hidden="true"
                />
              ) : null}
            </span>
            <span className="phone-switcher__label">{panel.label}</span>
            {dot ? <span className="visually-hidden">, {dotLabel}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
