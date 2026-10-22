import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearToasts } from '../../ui/index.js';
import { accountHandlers, json, renderAccount, routeFetch } from './test-helpers.js';

vi.mock('qrcode', () => ({
  default: { toDataURL: vi.fn(() => Promise.resolve('data:image/png;base64,QUJD')) },
}));

afterEach(() => {
  clearToasts();
  vi.unstubAllGlobals();
});

const twoFactor = (overrides: Record<string, unknown> = {}) => ({
  enabled: false,
  recoveryCodesLeft: 0,
  available: true,
  ...overrides,
});

describe('Account security', () => {
  it('changes the password, signing other sessions out by default', async () => {
    let posted: unknown;
    routeFetch({
      ...accountHandlers(),
      'POST /api/account/password': (init) => {
        posted = JSON.parse(String(init?.body));
        return json({ signedOut: 2 });
      },
    });
    renderAccount('/account/security');

    const submit = await screen.findByRole('button', { name: 'Change password' });
    expect(submit).toBeDisabled();
    expect(submit).toHaveAccessibleDescription('Enter your current password and a new one');

    await userEvent.type(screen.getByLabelText('Current password'), 'old-password-1');
    await userEvent.type(screen.getByLabelText('New password'), 'new-password-22');
    expect(screen.getByLabelText('Sign out everywhere else')).toBeChecked();
    await userEvent.click(screen.getByRole('button', { name: 'Change password' }));

    await waitFor(() =>
      expect(posted).toEqual({
        currentPassword: 'old-password-1',
        newPassword: 'new-password-22',
        signOutOthers: true,
      }),
    );
    expect(await screen.findByText('Password changed')).toBeInTheDocument();
    expect(screen.getByText('2 other sessions were signed out.')).toBeInTheDocument();
    expect(screen.getByLabelText('Current password')).toHaveValue('');
    expect(screen.getByLabelText('New password')).toHaveValue('');
  });

  it('puts a rejected new password under its own field', async () => {
    routeFetch({
      ...accountHandlers(),
      'POST /api/account/password': () =>
        json(
          {
            error: {
              code: 'VALIDATION_FAILED',
              message: 'Check the form.',
              details: {
                fields: [
                  { path: 'newPassword', message: 'That is the password you are already using' },
                ],
              },
            },
          },
          422,
        ),
    });
    renderAccount('/account/security');

    await userEvent.type(await screen.findByLabelText('Current password'), 'same-password-1');
    await userEvent.type(screen.getByLabelText('New password'), 'same-password-1');
    await userEvent.click(screen.getByRole('button', { name: 'Change password' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'That is the password you are already using',
    );
    expect(screen.getByLabelText('New password')).toHaveAttribute('aria-invalid', 'true');
  });

  it('says so, quietly, when the installation cannot keep a second factor', async () => {
    routeFetch({
      ...accountHandlers(),
      'GET /api/account/two-factor': () => json(twoFactor({ available: false })),
    });
    renderAccount('/account/security');

    const callout = (
      await screen.findByText('Two-factor sign-in is not available on this installation.')
    ).closest('[role="status"]');
    expect(callout).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Turn on' })).toBeNull();
  });

  it('turns two-factor on and shows the recovery codes once, behind an acknowledgement', async () => {
    let enabled = false;
    let confirmed: unknown;
    routeFetch({
      ...accountHandlers(),
      'GET /api/account/two-factor': () =>
        json(twoFactor(enabled ? { enabled: true, recoveryCodesLeft: 8 } : {})),
      'POST /api/account/two-factor/setup': () =>
        json({ secret: 'JBSWY3DPEHPK3PXP', uri: 'otpauth://totp/Workspace:ada?secret=JBSWY3DP' }),
      'POST /api/account/two-factor/confirm': (init) => {
        confirmed = JSON.parse(String(init?.body));
        enabled = true;
        return json({ recoveryCodes: ['aaaa-bbbb', 'cccc-dddd'] });
      },
    });
    renderAccount('/account/security');

    await userEvent.click(await screen.findByRole('button', { name: 'Turn on' }));
    const dialog = await screen.findByRole('dialog', { name: 'Turn on two-factor sign-in' });
    expect(
      await within(dialog).findByRole('img', { name: 'A QR code for your authenticator app' }),
    ).toHaveAttribute('src', 'data:image/png;base64,QUJD');
    expect(within(dialog).getByLabelText('Setup key')).toHaveTextContent('JBSWY3DPEHPK3PXP');
    expect(within(dialog).getByRole('button', { name: 'Copy setup key' })).toBeInTheDocument();

    const turnOn = within(dialog).getByRole('button', { name: 'Turn it on' });
    await userEvent.type(within(dialog).getByLabelText('Code from the app'), '12345');
    await userEvent.click(turnOn);
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Enter the six digits your app shows',
    );
    expect(confirmed).toBeUndefined();

    await userEvent.type(within(dialog).getByLabelText('Code from the app'), '6');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Turn it on' }));

    await waitFor(() => expect(confirmed).toEqual({ code: '123456' }));
    const codes = await screen.findByRole('dialog', { name: 'Save your recovery codes' });
    expect(within(codes).getByLabelText('Recovery codes')).toHaveTextContent('aaaa-bbbb');
    expect(within(codes).getByRole('button', { name: 'Copy recovery codes' })).toBeInTheDocument();
    expect(within(codes).getByRole('button', { name: 'Download' })).toBeInTheDocument();

    const done = within(codes).getByRole('button', { name: 'Done' });
    expect(done).toBeDisabled();
    expect(done).toHaveAccessibleDescription('Confirm you have saved the codes first');
    await userEvent.keyboard('{Escape}');
    expect(screen.getByRole('dialog', { name: 'Save your recovery codes' })).toBeInTheDocument();

    await userEvent.click(within(codes).getByLabelText('I have saved these codes'));
    await userEvent.click(within(codes).getByRole('button', { name: 'Done' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await screen.findByText('On')).toBeInTheDocument();
    expect(screen.getByText(/8 recovery codes left/)).toBeInTheDocument();
    expect(screen.queryByText('aaaa-bbbb')).toBeNull();
  });

  it('disables two-factor with the password and a code, and says new codes are not available yet', async () => {
    let disabled: unknown;
    let enabled = true;
    routeFetch({
      ...accountHandlers(),
      'GET /api/account/two-factor': () =>
        json(twoFactor(enabled ? { enabled: true, recoveryCodesLeft: 3 } : {})),
      'POST /api/account/two-factor/disable': (init) => {
        disabled = JSON.parse(String(init?.body));
        enabled = false;
        return new Response(null, { status: 204 });
      },
    });
    renderAccount('/account/security');

    const regenerate = await screen.findByRole('button', { name: 'New recovery codes' });
    expect(regenerate).toBeDisabled();
    expect(regenerate).toHaveAccessibleDescription(/not available yet/);

    await userEvent.click(screen.getByRole('button', { name: 'Disable' }));
    const dialog = await screen.findByRole('dialog', { name: 'Disable two-factor sign-in?' });
    const confirm = within(dialog).getByRole('button', { name: 'Disable two-factor sign-in' });
    expect(confirm).toBeDisabled();

    await userEvent.type(within(dialog).getByLabelText('Password'), 'hunter2hunter2');
    await userEvent.type(
      within(dialog).getByLabelText('Code from the app, or a recovery code'),
      '654321',
    );
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'Disable two-factor sign-in' }),
    );

    await waitFor(() => expect(disabled).toEqual({ password: 'hunter2hunter2', code: '654321' }));
    expect(await screen.findByText('Two-factor sign-in is off')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Turn on' })).toBeInTheDocument();
  });
});
