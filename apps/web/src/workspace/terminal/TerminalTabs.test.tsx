import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { TerminalTabs, type TerminalTabsProps } from './TerminalTabs.js';
import { TerminalKeyRow, withControl } from './TerminalKeyRow.js';

const tabs = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    key: `k${index + 1}`,
    label: `Shell ${index + 1}`,
  }));

function strip(props: Partial<TerminalTabsProps> = {}) {
  const handlers = {
    onSelect: vi.fn(),
    onNew: vi.fn(),
    onClose: vi.fn(),
    onRestart: vi.fn(),
    onClear: vi.fn(),
    onFind: vi.fn(),
  };
  render(
    <TerminalTabs
      tabs={tabs(2)}
      activeKey="k1"
      panelId={(key) => `panel-${key}`}
      {...handlers}
      {...props}
    />,
  );
  return handlers;
}

describe('the shell tabs', () => {
  it('names each shell and says which one is on screen', () => {
    strip();
    expect(screen.getByRole('tab', { name: 'Shell 1' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Shell 1' })).toHaveAttribute(
      'aria-controls',
      'panel-k1',
    );
    expect(screen.getByRole('tab', { name: 'Shell 2' })).toHaveAttribute('aria-selected', 'false');
  });

  it('moves between shells with the arrow keys', async () => {
    const { onSelect } = strip();
    screen.getByRole('tab', { name: 'Shell 1' }).focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(onSelect).toHaveBeenCalledWith('k2');
  });

  it('closes one shell by name', async () => {
    const { onClose } = strip();
    await userEvent.click(screen.getByRole('button', { name: 'Close Shell 2' }));
    expect(onClose).toHaveBeenCalledWith('k2');
  });

  it('opens another while there is room', async () => {
    const { onNew } = strip();
    await userEvent.click(screen.getByRole('button', { name: 'New terminal' }));
    expect(onNew).toHaveBeenCalled();
  });

  it('says why there is no room for a sixth', () => {
    strip({ tabs: tabs(5) });
    expect(screen.getByRole('button', { name: 'New terminal' })).toBeDisabled();
    expect(screen.getByText('Up to 5 shells per project')).toBeInTheDocument();
  });

  it('offers restarting a wedged shell from its menu, which "New terminal" no longer does', async () => {
    const { onRestart } = strip();
    await userEvent.click(screen.getByRole('button', { name: 'Shell actions' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Restart shell' }));
    expect(onRestart).toHaveBeenCalledWith('k1');
  });
});

describe('the phone key row', () => {
  it('sends the keys a phone keyboard lacks', async () => {
    const onKey = vi.fn();
    render(<TerminalKeyRow onKey={onKey} ctrlArmed={false} onCtrlChange={() => undefined} />);

    await userEvent.click(screen.getByRole('button', { name: 'Tab' }));
    await userEvent.click(screen.getByRole('button', { name: 'Up arrow' }));

    expect(onKey).toHaveBeenNthCalledWith(1, '\t');
    expect(onKey).toHaveBeenNthCalledWith(2, '\u001b[A');
  });

  it('arms Ctrl for the next letter', async () => {
    const onCtrlChange = vi.fn();
    render(
      <TerminalKeyRow onKey={() => undefined} ctrlArmed={false} onCtrlChange={onCtrlChange} />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Ctrl' }));
    expect(onCtrlChange).toHaveBeenCalledWith(true);
  });

  it('turns a letter into its control character', () => {
    expect(withControl('c')).toBe('\u0003');
    expect(withControl('D')).toBe('\u0004');
    expect(withControl('ab')).toBe('ab');
  });
});
