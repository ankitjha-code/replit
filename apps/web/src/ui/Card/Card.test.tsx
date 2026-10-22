import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Card } from './Card.js';

describe('Card', () => {
  it('renders as another element with tone and padding classes', () => {
    render(
      <Card as="section" tone="danger" padding="lg" aria-label="Danger zone">
        Delete project
      </Card>,
    );
    const card = screen.getByRole('region', { name: 'Danger zone' });
    expect(card.tagName).toBe('SECTION');
    expect(card).toHaveClass('ui-card--danger', 'ui-card--pad-lg');
  });
});
