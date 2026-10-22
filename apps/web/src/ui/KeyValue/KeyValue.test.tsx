import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { KeyValue } from './KeyValue.js';

describe('KeyValue', () => {
  it('is a definition list with copy buttons named after the term', () => {
    const { container } = render(
      <KeyValue
        items={[
          { term: 'Port', value: '5432', mono: true, copy: '5432' },
          { term: 'Host', value: 'db.internal' },
        ]}
      />,
    );
    expect(container.querySelector('dl')).not.toBeNull();
    expect(screen.getByText('Port').tagName).toBe('DT');
    expect(screen.getByText('5432').closest('dd')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Copy port' })).toBeInTheDocument();
  });

  it('shows skeleton rows while loading', () => {
    const { container } = render(<KeyValue items={[]} loading placeholderRows={2} />);
    expect(container.querySelector('dl')).toHaveAttribute('aria-busy', 'true');
    expect(container.querySelectorAll('dt')).toHaveLength(2);
  });
});
