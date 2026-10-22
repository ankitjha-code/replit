import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Skeleton } from './Skeleton.js';

describe('Skeleton', () => {
  it('is hidden from assistive technology and renders the asked-for lines', () => {
    const { container } = render(<Skeleton lines={3} />);
    const wrapper = container.firstElementChild;
    expect(wrapper).toHaveAttribute('aria-hidden', 'true');
    expect(wrapper?.querySelectorAll('.ui-skeleton')).toHaveLength(3);
    expect(wrapper?.lastElementChild).toHaveClass('ui-skeleton--short');
  });

  it('takes a shape and a size', () => {
    const { container } = render(<Skeleton shape="circle" width={32} height={32} />);
    expect(container.firstElementChild).toHaveClass('ui-skeleton--circle');
    expect(container.firstElementChild).toHaveStyle({ width: '32px', height: '32px' });
  });
});
