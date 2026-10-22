import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Badge, StatusPill } from './Badge.js';

describe('Badge', () => {
  it('always carries text with its colour', () => {
    render(<Badge tone="ok">Running</Badge>);
    expect(screen.getByText('Running')).toHaveClass('ui-badge--ok');
  });

  it('draws a live dot only when asked', () => {
    const { container } = render(
      <StatusPill tone="info" dot>
        Live
      </StatusPill>,
    );
    expect(container.querySelector('.ui-badge__dot')).not.toBeNull();
    expect(screen.getByText('Live')).toHaveClass('ui-badge--pill');
  });
});
