import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Tooltip } from './Tooltip.js';

describe('Tooltip', () => {
  it('opens on focus as well as hover', async () => {
    render(
      <Tooltip content="Copy the URL">
        <button type="button">Copy</button>
      </Tooltip>,
    );
    await userEvent.tab();
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Copy the URL');
  });
});
