import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Field } from '../../components/Field.js';

describe('Field', () => {
  it('labels its input and reports the error, not the hint, when both are given', () => {
    render(
      <Field
        id="email"
        label="Email"
        value=""
        onChange={() => {}}
        hint="We never share it"
        error="Enter an email"
      />,
    );
    const input = screen.getByLabelText('Email');
    expect(input).toHaveAttribute('name', 'email');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('alert')).toHaveTextContent('Enter an email');
    expect(input).toHaveAccessibleDescription('Enter an email');
    expect(screen.queryByText('We never share it')).toBeNull();
  });

  it('passes the typed value through the { target: { value } } shape', async () => {
    const seen: string[] = [];
    const onChange = vi.fn((event: { target: { value: string } }) => seen.push(event.target.value));
    render(<Field id="name" label="Name" value="" onChange={onChange} />);
    await userEvent.type(screen.getByLabelText('Name'), 'a');
    expect(seen).toEqual(['a']);
  });

  it('reveals a password on request', async () => {
    render(<Field id="pw" label="Password" as="password" value="secret" onChange={() => {}} />);
    const input = screen.getByLabelText('Password');
    expect(input).toHaveAttribute('type', 'password');
    await userEvent.click(screen.getByRole('button', { name: 'Show password' }));
    expect(input).toHaveAttribute('type', 'text');
    expect(screen.getByRole('button', { name: 'Hide password' })).toBeInTheDocument();
  });

  it('renders a textarea, a select and a custom control under the same label', () => {
    render(
      <>
        <Field id="note" label="Note" as="textarea" value="" onChange={() => {}} />
        <Field
          id="role"
          label="Role"
          as="select"
          value="editor"
          onChange={() => {}}
          options={[
            { value: 'viewer', label: 'Viewer' },
            { value: 'editor', label: 'Editor' },
          ]}
        />
        <Field id="custom" label="Custom">
          <input id="custom" />
        </Field>
      </>,
    );
    expect(screen.getByLabelText('Note').tagName).toBe('TEXTAREA');
    expect(screen.getByLabelText('Role')).toHaveValue('editor');
    expect(screen.getByLabelText('Custom').tagName).toBe('INPUT');
  });

  it('reports leaving the field, for a check that waits until the person moves on', async () => {
    const onBlur = vi.fn();
    render(
      <Field id="username" label="Username" value="admin" onChange={() => {}} onBlur={onBlur} />,
    );
    await userEvent.click(screen.getByLabelText('Username'));
    expect(onBlur).not.toHaveBeenCalled();
    await userEvent.tab();
    expect(onBlur).toHaveBeenCalledTimes(1);
  });
});
