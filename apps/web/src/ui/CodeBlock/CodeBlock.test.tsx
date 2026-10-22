import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CodeBlock } from './CodeBlock.js';

describe('CodeBlock', () => {
  it('labels the block and offers a copy named after it', () => {
    render(<CodeBlock code="CNAME app example.test" label="DNS record" copy />);
    expect(screen.getByLabelText('DNS record')).toHaveTextContent('CNAME app example.test');
    expect(screen.getByRole('button', { name: 'Copy dns record' })).toBeInTheDocument();
  });
});
