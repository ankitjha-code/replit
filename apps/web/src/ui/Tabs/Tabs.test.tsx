import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { TabPanel, Tabs } from './Tabs.js';

const items = [
  { value: 'output', label: 'Output', badge: 3 },
  { value: 'shell', label: 'Shell' },
  { value: 'logs', label: 'Logs', disabledReason: 'Start the environment first' },
];

describe('Tabs', () => {
  it('renders a tab list whose tabs control their panels and move with the arrow keys', async () => {
    render(
      <Tabs items={items} defaultValue="output" label="Console">
        <TabPanel value="output">Output panel</TabPanel>
        <TabPanel value="shell">Shell panel</TabPanel>
        <TabPanel value="logs">Logs panel</TabPanel>
      </Tabs>,
    );
    const list = screen.getByRole('tablist', { name: 'Console' });
    expect(list).toBeInTheDocument();
    const output = screen.getByRole('tab', { name: /Output/ });
    expect(output).toHaveAttribute('aria-selected', 'true');
    expect(output).toHaveAttribute('aria-controls', screen.getByRole('tabpanel').id);
    expect(screen.getByText('3')).toBeInTheDocument();

    output.focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Shell' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Shell panel');
  });

  it('keeps a disabled tab visible with its reason', () => {
    render(<Tabs items={items} defaultValue="output" label="Console" />);
    const logs = screen.getByRole('tab', { name: /Logs/ });
    expect(logs).toBeDisabled();
    expect(logs).toHaveTextContent('Start the environment first');
  });
});
