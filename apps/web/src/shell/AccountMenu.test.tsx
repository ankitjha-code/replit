import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../lib/auth-context.js';
import { NavigationGuardProvider, useRegisterGuard } from '../lib/navigation-guard.js';
import { setThemePreference } from '../theme/theme.js';
import { AccountMenu } from './AccountMenu.js';

const publicUser = {
  id: '018f0000-0000-7000-8000-000000000001',
  email: 'ada@example.test',
  username: 'ada',
  displayName: null,
  emailVerified: false,
  isOperator: false,
  createdAt: '2026-01-01T00:00:00.000Z',
};

const json = (body: unknown, status = 200) =>
  new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

function routeFetch(handlers: Record<string, () => Response>) {
  const spy = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    const key = Object.keys(handlers).find((k) => url.includes(k));
    if (!key) throw new Error(`unexpected request to ${url}`);
    return Promise.resolve(handlers[key]!());
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

function Where(): React.JSX.Element {
  const location = useLocation();
  return <output data-testid="where">{location.pathname}</output>;
}

function Dirty(): null {
  useRegisterGuard('test', {
    isDirty: () => true,
    flush: () => Promise.resolve(),
    describe: () => '1 file with unsaved changes',
  });
  return null;
}

const renderMenu = (extra?: React.ReactNode, initialPath = '/account') =>
  render(
    <AuthProvider>
      <MemoryRouter initialEntries={[initialPath]}>
        <NavigationGuardProvider>
          {extra}
          <Where />
          <Routes>
            <Route path="*" element={<AccountMenu onShowShortcuts={() => undefined} />} />
          </Routes>
        </NavigationGuardProvider>
      </MemoryRouter>
    </AuthProvider>,
  );

afterEach(() => {
  vi.unstubAllGlobals();
  setThemePreference('system');
});

describe('AccountMenu', () => {
  it('offers Sign in and Sign up to a visitor', async () => {
    routeFetch({ '/api/auth/me': () => json({ user: null }) });
    renderMenu();
    expect(await screen.findByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login');
    expect(screen.getByRole('link', { name: 'Sign up' })).toHaveAttribute('href', '/register');
  });

  it('keeps Sign up primary only where the page has no primary of its own', async () => {
    routeFetch({ '/api/auth/me': () => json({ user: null }) });
    const landing = renderMenu(undefined, '/');
    // The landing's "Create an account" is the one accent-filled button there.
    expect(await screen.findByRole('link', { name: 'Sign up' })).toHaveClass(
      'ui-button--secondary',
    );
    landing.unmount();

    renderMenu(undefined, '/status');
    expect(await screen.findByRole('link', { name: 'Sign up' })).toHaveClass('ui-button--primary');
  });

  it('names its trigger exactly after the user and lists the email once inside', async () => {
    routeFetch({ '/api/auth/me': () => json({ user: publicUser }) });
    renderMenu();
    const trigger = await screen.findByRole('button', { name: 'ada' });
    // The avatar's initials must not leak into the name or the page text.
    expect(screen.getByText('ada', { exact: true })).toBeInTheDocument();
    expect(trigger).not.toHaveAttribute('title');

    await userEvent.click(trigger);
    const menu = await screen.findByRole('menu');
    expect(menu).toHaveTextContent('ada@example.test');
    expect(screen.getByRole('menuitem', { name: 'Account' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Sign out' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'System status' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Operations' })).toBeNull();
  });

  it('switches the theme from the menu', async () => {
    routeFetch({ '/api/auth/me': () => json({ user: publicUser }) });
    renderMenu();
    await userEvent.click(await screen.findByRole('button', { name: 'ada' }));
    await userEvent.click(await screen.findByRole('menuitemcheckbox', { name: 'Light' }));
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('light'));
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  });

  it('signs out through the menu and returns home', async () => {
    const spy = routeFetch({
      '/api/auth/me': () => json({ user: publicUser }),
      '/api/auth/logout': () => json(null, 204),
    });
    renderMenu();
    await userEvent.click(await screen.findByRole('button', { name: 'ada' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Sign out' }));

    await waitFor(() => expect(screen.getByRole('link', { name: 'Sign in' })).toBeInTheDocument());
    expect(screen.queryByText('ada', { exact: true })).toBeNull();
    expect(screen.getByTestId('where')).toHaveTextContent('/');
    expect(spy.mock.calls.some(([input]) => String(input).includes('/api/auth/logout'))).toBe(true);
  });

  it('asks before signing out when there is unsaved work', async () => {
    const spy = routeFetch({
      '/api/auth/me': () => json({ user: publicUser }),
      '/api/auth/logout': () => json(null, 204),
    });
    renderMenu(<Dirty />);
    await userEvent.click(await screen.findByRole('button', { name: 'ada' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Sign out' }));

    expect(await screen.findByRole('dialog', { name: 'You have unsaved changes' })).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    // Still signed in, and nothing was sent.
    expect(screen.getByRole('button', { name: 'ada' })).toBeInTheDocument();
    expect(spy.mock.calls.some(([input]) => String(input).includes('/api/auth/logout'))).toBe(
      false,
    );
  });
});
