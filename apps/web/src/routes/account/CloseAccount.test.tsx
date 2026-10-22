import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearToasts } from '../../ui/index.js';
import { accountHandlers, json, publicUser, renderAccount, routeFetch } from './test-helpers.js';

afterEach(() => {
  clearToasts();
  vi.unstubAllGlobals();
});

async function openDialog() {
  await userEvent.click(await screen.findByRole('button', { name: 'Close account' }));
  return screen.findByRole('dialog', { name: 'Close this account permanently?' });
}

describe('Close account', () => {
  it('needs the password and the username, matched without regard to case', async () => {
    routeFetch(accountHandlers());
    renderAccount('/account/close');

    const dialog = await openDialog();
    const confirm = within(dialog).getByRole('button', { name: 'Close this account permanently' });
    expect(confirm).toBeDisabled();
    expect(confirm).toHaveAccessibleDescription('Enter your password');

    await userEvent.type(within(dialog).getByLabelText('Your password'), 'hunter2hunter2');
    expect(confirm).toBeDisabled();
    expect(confirm).toHaveAccessibleDescription('Type ada to confirm');

    await userEvent.type(within(dialog).getByLabelText('Type ada to confirm'), 'ADa');
    expect(
      within(dialog).getByRole('button', { name: 'Close this account permanently' }),
    ).toBeEnabled();
  });

  it('deletes the account, then asks who we are so the shell signs out', async () => {
    let me = 0;
    let deleted: unknown;
    const calls = routeFetch({
      ...accountHandlers(),
      'GET /api/auth/me': () => {
        me += 1;
        return json({ user: me === 1 ? publicUser : null });
      },
      'DELETE /api/account': (init) => {
        deleted = JSON.parse(String(init?.body));
        return json({ projectsDeleted: 2 });
      },
    });
    renderAccount('/account/close');

    const dialog = await openDialog();
    await userEvent.type(within(dialog).getByLabelText('Your password'), 'hunter2hunter2');
    await userEvent.type(within(dialog).getByLabelText('Type ada to confirm'), 'ada');
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'Close this account permanently' }),
    );

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(deleted).toEqual({ password: 'hunter2hunter2', confirmUsername: 'ada' });
    const remove = calls.indexOf('DELETE /api/account');
    expect(remove).toBeGreaterThan(-1);
    expect(calls.slice(remove + 1)).toContain('GET /api/auth/me');
  });

  it('keeps a refused close inside the dialog with the reason', async () => {
    routeFetch({
      ...accountHandlers(),
      'DELETE /api/account': () =>
        json({ error: { code: 'UNAUTHORIZED', message: 'That password is not right.' } }, 401),
    });
    renderAccount('/account/close');

    const dialog = await openDialog();
    await userEvent.type(within(dialog).getByLabelText('Your password'), 'wrong-wrong-wrong');
    await userEvent.type(within(dialog).getByLabelText('Type ada to confirm'), 'ada');
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'Close this account permanently' }),
    );

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'That password is not right.',
    );
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());
    expect(screen.queryByRole('heading', { name: 'Sign in' })).toBeNull();
  });
});
