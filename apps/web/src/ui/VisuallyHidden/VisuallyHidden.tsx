import { forwardRef, type ComponentPropsWithoutRef } from 'react';
import { VisuallyHidden as Primitive } from 'radix-ui';

export type VisuallyHiddenProps = ComponentPropsWithoutRef<typeof Primitive.Root>;

/** Text for assistive technology only. Prefer this over the legacy .visually-hidden class in new code. */
export const VisuallyHidden = forwardRef<HTMLSpanElement, VisuallyHiddenProps>(
  function VisuallyHidden(props, ref) {
    return <Primitive.Root ref={ref} {...props} />;
  },
);
