import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { SectionHeader } from './SectionHeader.js';

describe('SectionHeader', () => {
  it('is an h2 with the exact title, a count and help behind a popover', async () => {
    render(
      <SectionHeader
        id="members"
        title="People"
        count={3}
        description="Who can open this project."
        help={<p>Owners can do everything.</p>}
      />,
    );
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('People');
    expect(screen.getByText('3')).toHaveClass('ui-section-header__count');
    await userEvent.click(screen.getByRole('button', { name: 'About this section' }));
    expect(await screen.findByRole('dialog', { name: 'About this section' })).toHaveTextContent(
      'Owners can do everything.',
    );
  });
});
