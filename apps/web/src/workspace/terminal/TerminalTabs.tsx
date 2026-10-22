import { useRef, type KeyboardEvent } from 'react';
import { ContextMenu, IconButton, Menu, type MenuItem } from '../../ui/index.js';
import { ArrowClockwise, Broom, DotsThree, MagnifyingGlass, Plus, X } from '../../ui/icons.js';

export const MAX_SHELLS = 5;

export interface ShellTabInfo {
  key: string;
  label: string;
  lastActiveAt?: string | undefined;
}

export interface TerminalTabsProps {
  tabs: ShellTabInfo[];
  activeKey: string | undefined;
  panelId: (key: string) => string;
  onSelect: (key: string) => void;
  onNew: () => void;
  onClose: (key: string) => void;
  onRestart: (key: string) => void;
  onClear: (key: string) => void;
  onFind: (key: string) => void;
}

export function TerminalTabs({
  tabs,
  activeKey,
  panelId,
  onSelect,
  onNew,
  onClose,
  onRestart,
  onClear,
  onFind,
}: TerminalTabsProps): React.JSX.Element {
  const list = useRef<HTMLDivElement>(null);
  const atLimit = tabs.length >= MAX_SHELLS;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const index = tabs.findIndex((tab) => tab.key === activeKey);
    if (index === -1) return;
    let next = index;
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    else return;
    event.preventDefault();
    const target = tabs[next];
    if (!target) return;
    onSelect(target.key);
    list.current?.querySelector<HTMLElement>(`[data-shell-tab="${target.key}"]`)?.focus();
  };

  const itemsFor = (tab: ShellTabInfo): MenuItem[] => [
    {
      label: 'Find',
      icon: MagnifyingGlass,
      shortcut: ['Mod', 'F'],
      onSelect: () => onFind(tab.key),
    },
    { label: 'Clear', icon: Broom, onSelect: () => onClear(tab.key) },
    { label: 'Restart shell', icon: ArrowClockwise, onSelect: () => onRestart(tab.key) },
    { label: `Close ${tab.label}`, icon: X, tone: 'danger', onSelect: () => onClose(tab.key) },
  ];

  const active = tabs.find((tab) => tab.key === activeKey);

  return (
    <div className="term-tabs">
      <div
        ref={list}
        className="term-tabs__list"
        role="tablist"
        aria-label="Shells"
        onKeyDown={onKeyDown}
      >
        {tabs.map((tab) => {
          const selected = tab.key === activeKey;
          return (
            <ContextMenu key={tab.key} items={itemsFor(tab)} label={`${tab.label} actions`}>
              <div className={`term-tabs__tab${selected ? ' term-tabs__tab--active' : ''}`}>
                <button
                  type="button"
                  role="tab"
                  data-shell-tab={tab.key}
                  aria-selected={selected}
                  aria-controls={panelId(tab.key)}
                  tabIndex={selected ? 0 : -1}
                  className="term-tabs__select"
                  title={
                    tab.lastActiveAt
                      ? `Last used ${new Date(tab.lastActiveAt).toLocaleString()}`
                      : undefined
                  }
                  onClick={() => onSelect(tab.key)}
                >
                  {tab.label}
                </button>
                <IconButton
                  size="sm"
                  label={`Close ${tab.label}`}
                  icon={X}
                  className="term-tabs__close"
                  onClick={() => onClose(tab.key)}
                />
              </div>
            </ContextMenu>
          );
        })}
      </div>
      <IconButton
        size="sm"
        label="New terminal"
        icon={Plus}
        shortcut={['Mod', 'Shift', '`']}
        {...(atLimit ? { disabledReason: `Up to ${MAX_SHELLS} shells per project` } : {})}
        onClick={onNew}
      />
      {active ? (
        <Menu
          label={`${active.label} actions`}
          align="end"
          trigger={<IconButton size="sm" label="Shell actions" icon={DotsThree} />}
          items={itemsFor(active)}
        />
      ) : null}
    </div>
  );
}
