import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Avatar, AvatarGroup, initialsOf, presenceIndex } from './Avatar.js';

describe('Avatar', () => {
  it('shows initials, is named after the person, and colours by a stable hash', () => {
    render(<Avatar name="Ada Lovelace" userId="u1" />);
    const avatar = screen.getByRole('img', { name: 'Ada Lovelace' });
    expect(avatar).toHaveTextContent('AL');
    expect(avatar).toHaveStyle({ background: `var(--presence-${presenceIndex('u1')})` });
    expect(initialsOf('ada')).toBe('AD');
    expect(presenceIndex('u1')).toBe(presenceIndex('u1'));
  });

  it('collapses a group past the maximum', () => {
    const people = ['Ada', 'Bob', 'Cy', 'Di', 'Ed', 'Fay'].map((name) => ({ name }));
    render(<AvatarGroup people={people} max={4} />);
    expect(screen.getByRole('group', { name: '6 people' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: '2 more: Ed, Fay' })).toHaveTextContent('+2');
  });
});
