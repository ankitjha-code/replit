import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Meter, meterTone } from './Meter.js';

describe('Meter', () => {
  it('is a meter with the formatted value and an automatic tone near the ceiling', () => {
    render(<Meter label="Memory" value={970} max={1000} format={(v) => `${v} MB`} />);
    const meter = screen.getByRole('meter', { name: 'Memory' });
    expect(meter).toHaveAttribute('aria-valuenow', '970');
    expect(meter).toHaveAttribute('aria-valuetext', '970 MB');
    expect(meter).toHaveClass('ui-meter', 'ui-meter--danger');
    expect(meterTone(0.85)).toBe('warn');
    expect(meterTone(0.2)).toBe('neutral');
  });

  it('says so when nothing was measured rather than drawing an empty bar', () => {
    const { container } = render(<Meter label="CPU" value={null} max={100} />);
    expect(screen.queryByRole('meter')).toBeNull();
    expect(screen.getByText('Not measured')).toBeInTheDocument();
    expect(container.querySelector('.ui-meter__track')).toBeNull();
  });

  it('lets stacked meters share one label width so their tracks line up', () => {
    render(<Meter label="Environments running" value={1} max={3} labelWidth="10rem" />);
    const meter = screen.getByRole('meter', { name: 'Environments running' });
    expect(meter.style.getPropertyValue('--ui-meter-label')).toBe('10rem');
  });

  it('leaves the label column to fit its text when no width is given', () => {
    render(<Meter label="CPU" value={1} max={3} style={{ marginTop: 4 }} />);
    const meter = screen.getByRole('meter', { name: 'CPU' });
    expect(meter.style.getPropertyValue('--ui-meter-label')).toBe('');
    expect(meter.style.marginTop).toBe('4px');
  });
});
