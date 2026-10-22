import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UiProvider, clearToasts } from '../ui/index.js';
import { ProjectMembers } from './ProjectMembers.js';
import { PROJECT_ID, json, members, publicUser, routeFetch } from './settings/test-helpers.js';

const MEMBERS_URL = `/api/projects/${PROJECT_ID}/members`;
const GRACE_ID = '018f0000-0000-7000-8000-000000000002';

function renderMembers(props: Partial<Parameters<typeof ProjectMembers>[0]> = {}) {
  const onLeft = vi.fn();
  render(
    <UiProvider>
      <ProjectMembers
        projectId={PROJECT_ID}
        currentUserId={publicUser.id}
        canManage
        onLeft={onLeft}
        {...props}
      />
    </UiProvider>,
  );
  return { onLeft };
}

afterEach(() => {
  clearToasts();
  vi.unstubAllGlobals();
});

describe('ProjectMembers', () => {
  it('lists everyone, marks your own row and names each action after its person', async () => {
    routeFetch({ [`GET ${MEMBERS_URL}`]: () => json(members()) });
    renderMembers();

    await screen.findByText('Grace Hopper');
    const table = screen.getByRole('table', { name: 'Members of this project' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText('You')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('Owner')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('Grace Hopper')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('@grace')).toBeInTheDocument();

    // Your own role is not editable, and you cannot remove yourself from here.
    expect(screen.queryByRole('combobox', { name: 'Role of ada' })).toBeNull();
    expect(screen.getByRole('combobox', { name: 'Role of grace' })).toHaveValue('EDITOR');
    expect(screen.getByRole('button', { name: 'Remove grace' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove ada' })).toBeNull();
    // ada is the only owner here, so leaving is offered but explained.
    const leave = screen.getByRole('button', { name: 'Leave this project' });
    expect(leave).toBeDisabled();
    expect(leave).toHaveAccessibleDescription(
      'You are the only owner. Make somebody else an owner first.',
    );
  });

  it('changes a role only after the confirm, then says so', async () => {
    let patched: unknown;
    const calls = routeFetch({
      [`GET ${MEMBERS_URL}`]: () => json(members()),
      [`PATCH ${MEMBERS_URL}/${GRACE_ID}`]: (init) => {
        patched = JSON.parse(String(init?.body));
        return json({ member: { ...members().members[1], role: 'VIEWER' } });
      },
    });
    renderMembers();

    const select = await screen.findByRole('combobox', { name: 'Role of grace' });
    await userEvent.selectOptions(select, 'VIEWER');
    expect(patched).toBeUndefined();

    const dialog = await screen.findByRole('alertdialog', { name: 'Change grace to viewer?' });
    expect(dialog).toHaveTextContent('grace can look at files and output and nothing more.');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Change role' }));

    await waitFor(() => expect(patched).toEqual({ role: 'VIEWER' }));
    expect(await screen.findByText('grace is now a viewer')).toBeInTheDocument();
    // The list is read again rather than patched by hand.
    expect(calls.filter((call) => call === `GET ${MEMBERS_URL}`).length).toBeGreaterThan(1);
  });

  it('removes a person after a confirm that names them', async () => {
    const calls = routeFetch({
      [`GET ${MEMBERS_URL}`]: () => json(members()),
      [`DELETE ${MEMBERS_URL}/${GRACE_ID}`]: () => new Response(null, { status: 204 }),
    });
    renderMembers();

    await userEvent.click(await screen.findByRole('button', { name: 'Remove grace' }));
    const dialog = await screen.findByRole('alertdialog', {
      name: 'Remove grace from this project?',
    });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove grace' }));

    await waitFor(() => expect(calls).toContain(`DELETE ${MEMBERS_URL}/${GRACE_ID}`));
    expect(await screen.findByText('grace removed')).toBeInTheDocument();
  });

  it('adds somebody by username with the chosen role, then clears the form', async () => {
    let posted: unknown;
    routeFetch({
      [`GET ${MEMBERS_URL}`]: () => json(members()),
      [`POST ${MEMBERS_URL}`]: (init) => {
        posted = JSON.parse(String(init?.body));
        return json({
          member: {
            userId: '018f0000-0000-7000-8000-000000000003',
            username: 'linus',
            displayName: null,
            role: 'VIEWER',
            joinedAt: '2026-01-03T00:00:00.000Z',
          },
        });
      },
    });
    renderMembers();
    await screen.findByRole('table');

    const username = screen.getByLabelText('Username');
    await userEvent.type(username, 'linus');
    await userEvent.selectOptions(screen.getByLabelText('Role'), 'VIEWER');
    await userEvent.click(screen.getByRole('button', { name: 'Add to project' }));

    await waitFor(() => expect(posted).toEqual({ username: 'linus', role: 'VIEWER' }));
    expect(await screen.findByText('linus added as viewer')).toBeInTheDocument();
    expect(username).toHaveValue('');
  });

  it('puts a rejected username under its field and sends nothing for an empty one', async () => {
    const calls = routeFetch({
      [`GET ${MEMBERS_URL}`]: () => json(members()),
      [`POST ${MEMBERS_URL}`]: () =>
        json(
          {
            error: {
              code: 'NOT_FOUND',
              message: 'There is no account with that username',
              details: { fields: [{ path: 'username', message: 'No account with that username' }] },
            },
          },
          404,
        ),
    });
    renderMembers();
    await screen.findByRole('table');

    await userEvent.click(screen.getByRole('button', { name: 'Add to project' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Enter the username of the person to add',
    );
    expect(calls.some((call) => call.startsWith('POST'))).toBe(false);

    await userEvent.type(screen.getByLabelText('Username'), 'nobody');
    await userEvent.click(screen.getByRole('button', { name: 'Add to project' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'There is no account with that username',
    );
    expect(screen.getByLabelText('Username')).toHaveAttribute('aria-invalid', 'true');
  });

  it('shows an editor the list without any way to change it, but lets them leave', async () => {
    const calls = routeFetch({
      [`GET ${MEMBERS_URL}`]: () => json(members('EDITOR')),
      [`DELETE ${MEMBERS_URL}/me`]: () => new Response(null, { status: 204 }),
    });
    const { onLeft } = renderMembers({ canManage: false });

    await screen.findByRole('table');
    expect(screen.queryByLabelText('Username')).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Remove / })).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Leave this project' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Leave this project?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Leave project' }));

    await waitFor(() => expect(onLeft).toHaveBeenCalledTimes(1));
    expect(calls).toContain(`DELETE ${MEMBERS_URL}/me`);
  });

  it('tells a lone owner to invite people, and why they cannot leave yet', async () => {
    routeFetch({
      [`GET ${MEMBERS_URL}`]: () => json({ ...members(), members: members().members.slice(0, 1) }),
    });
    renderMembers();

    expect(await screen.findByText('Only you have access.')).toBeInTheDocument();
    // One primary on the page: the empty state's, not the form's submit too.
    expect(screen.getByRole('button', { name: 'Invite people' })).toHaveClass('ui-button--primary');
    expect(screen.getByRole('button', { name: 'Add to project' })).not.toHaveClass(
      'ui-button--primary',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Invite people' }));
    expect(screen.getByLabelText('Username')).toHaveFocus();

    const leave = screen.getByRole('button', { name: 'Leave this project' });
    expect(leave).toBeDisabled();
    expect(leave).toHaveAccessibleDescription(
      'You are the only owner. Make somebody else an owner first.',
    );
  });

  it('shows a failed read inside the section with a retry', async () => {
    let attempts = 0;
    routeFetch({
      [`GET ${MEMBERS_URL}`]: () => {
        attempts += 1;
        return attempts === 1
          ? json({ error: { code: 'INTERNAL', message: 'The database is away.' } }, 500)
          : json(members());
      },
    });
    renderMembers();

    expect(await screen.findByRole('alert')).toHaveTextContent('The database is away.');
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Grace Hopper')).toBeInTheDocument();
  });
});
