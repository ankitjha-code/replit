import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Users, Trash } from '../icons.js';
import { Table } from './Table.js';

interface Member {
  id: string;
  name: string;
  role: string;
}

const columns = [
  { key: 'name', header: 'Name', cell: (row: Member) => row.name },
  { key: 'role', header: 'Role', cell: (row: Member) => row.role },
];
const empty = {
  icon: Users,
  title: 'No members yet',
  body: 'Invite someone and they appear here.',
};

describe('Table', () => {
  it('is a real table whose row actions are named after the row', () => {
    const onRemove = vi.fn();
    render(
      <Table
        caption="Members"
        columns={columns}
        rows={[
          { id: '1', name: 'alice', role: 'Owner' },
          { id: '2', name: 'bob', role: 'Editor' },
        ]}
        rowKey={(row) => row.id}
        rowName={(row) => row.name}
        rowActions={() => [{ label: 'Remove', icon: Trash, onSelect: onRemove, tone: 'danger' }]}
        empty={empty}
        pagination={{ count: 2, total: 12, onMore: () => {} }}
      />,
    );
    const table = screen.getByRole('table', { name: 'Members' });
    expect(within(table).getAllByRole('columnheader')).toHaveLength(3);
    expect(screen.getByRole('button', { name: 'Remove alice' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove bob' })).toBeInTheDocument();
    expect(screen.getByText('2 of 12')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show more' })).toBeInTheDocument();
  });

  it('renders the empty state, skeleton rows and an error with Retry', () => {
    const { rerender } = render(
      <Table
        caption="Members"
        columns={columns}
        rows={[]}
        rowKey={(row) => row.id}
        empty={empty}
      />,
    );
    expect(screen.getByText('No members yet')).toBeInTheDocument();

    rerender(
      <Table
        caption="Members"
        columns={columns}
        rows={[]}
        rowKey={(row) => row.id}
        empty={empty}
        loading
        placeholderRows={2}
      />,
    );
    expect(screen.getByRole('table').closest('[aria-busy="true"]')).not.toBeNull();
    expect(screen.getAllByRole('row')).toHaveLength(3);

    rerender(
      <Table
        caption="Members"
        columns={columns}
        rows={[]}
        rowKey={(row) => row.id}
        empty={empty}
        error="Could not load members"
        onRetry={() => {}}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load members');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});
