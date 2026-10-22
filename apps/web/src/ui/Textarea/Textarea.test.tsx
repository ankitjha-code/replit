import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Textarea } from './Textarea.js';

describe('Textarea', () => {
  it('grows with its lines between one and six rows', () => {
    const { rerender } = render(<Textarea aria-label="Note" autoGrow value="" readOnly />);
    expect(screen.getByLabelText('Note')).toHaveAttribute('rows', '1');
    rerender(<Textarea aria-label="Note" autoGrow value={'a\nb\nc'} readOnly />);
    expect(screen.getByLabelText('Note')).toHaveAttribute('rows', '3');
    rerender(<Textarea aria-label="Note" autoGrow value={'1\n2\n3\n4\n5\n6\n7\n8'} readOnly />);
    expect(screen.getByLabelText('Note')).toHaveAttribute('rows', '6');
  });

  it('is invalid and disabled with a reason', () => {
    render(<Textarea aria-label="Note" invalid disabledReason="Read-only access" />);
    const area = screen.getByLabelText('Note');
    expect(area).toHaveAttribute('aria-invalid', 'true');
    expect(area).toBeDisabled();
    expect(area).toHaveAccessibleDescription('Read-only access');
  });
});
