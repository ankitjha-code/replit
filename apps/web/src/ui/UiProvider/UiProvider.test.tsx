import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { IconButton } from '../IconButton/IconButton.js';
import { clearToasts, toast } from '../Toast/Toast.js';
import { X } from '../icons.js';
import { UiProvider } from './UiProvider.js';

afterEach(() => clearToasts());

describe('UiProvider', () => {
  it('mounts the toast viewport and lets tooltips share one provider', () => {
    render(
      <UiProvider>
        <IconButton label="Close" icon={X} />
      </UiProvider>,
    );
    expect(screen.getByRole('region', { name: /Notifications/ })).toBeInTheDocument();
    act(() => {
      toast({ title: 'Hello' });
    });
    expect(screen.getByText('Hello')).toBeInTheDocument();
  });
});
