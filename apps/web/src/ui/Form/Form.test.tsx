import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Input } from '../Input/Input.js';
import { FormGrid, FormRow } from './Form.js';

describe('FormRow and FormGrid', () => {
  it('reaches the control from the label and renders the actions row', () => {
    render(
      <FormGrid columns={2} actions={<button type="submit">Save</button>}>
        <FormRow label="Name" htmlFor="name" hint="Shown to members">
          <Input id="name" />
        </FormRow>
      </FormGrid>,
    );
    expect(screen.getByLabelText('Name')).toBeInTheDocument();
    expect(screen.getByText('Shown to members')).toHaveClass('ui-form-row__hint');
    expect(screen.getByRole('button', { name: 'Save' }).parentElement).toHaveClass(
      'ui-form-grid__actions',
    );
  });
});
