import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UiProvider, clearToasts } from '../ui/index.js';
import { ProjectDomains } from './ProjectDomains.js';
import { PROJECT_ID, SHIP_API, domain, domainList } from './ship/fixtures.js';
import { json, routeFetch } from './settings/test-helpers.js';

/**
 * Domains: the subdomain is a setting that asks before it changes, a custom
 * domain carries its DNS record until it is verified, and only its own Check
 * is busy while it is checked.
 */

function renderDomains(onSubdomainChanged = vi.fn()) {
  render(
    <UiProvider>
      <ProjectDomains
        projectId={PROJECT_ID}
        addressNonce={0}
        onSubdomainChanged={onSubdomainChanged}
      />
    </UiProvider>,
  );
  return { onSubdomainChanged };
}

afterEach(() => {
  clearToasts();
  vi.unstubAllGlobals();
});

describe('ProjectDomains', () => {
  it('explains that the subdomain arrives with the first deploy', async () => {
    routeFetch({
      [`GET ${SHIP_API}/domains`]: () => json(domainList({ subdomain: null, target: null })),
    });
    renderDomains();

    expect(
      await screen.findByText('Your platform subdomain is assigned on the first deploy.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to Deployments' })).toHaveAttribute(
      'href',
      '#deploy-deployments',
    );
    expect(screen.queryByLabelText('Platform subdomain')).not.toBeInTheDocument();
  });

  it('previews the full address and asks before changing the subdomain', async () => {
    let sent: unknown;
    const calls = routeFetch({
      [`GET ${SHIP_API}/domains`]: () => json(domainList()),
      [`PUT ${SHIP_API}/domains/subdomain`]: (init) => {
        sent = JSON.parse(String(init?.body));
        return new Response(null, { status: 204 });
      },
    });
    const { onSubdomainChanged } = renderDomains();

    const field = await screen.findByLabelText('Platform subdomain');
    await waitFor(() => expect(field).toHaveValue('hello'));
    const change = screen.getByRole('button', { name: 'Change subdomain' });
    expect(change).toBeDisabled();
    expect(change).toHaveAccessibleDescription('This is the current subdomain');

    await userEvent.clear(field);
    await userEvent.type(field, 'World');
    expect(screen.getByText('world.deploy.localhost:4100')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Change subdomain' }));

    const dialog = await screen.findByRole('alertdialog', {
      name: 'Change the subdomain to world.deploy.localhost:4100?',
    });
    expect(within(dialog).getByText(/Links to the old address stop working/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Change subdomain' }));

    await waitFor(() => expect(sent).toEqual({ subdomain: 'world' }));
    expect(onSubdomainChanged).toHaveBeenCalled();
    expect(calls.filter((call) => call.startsWith('GET')).length).toBeGreaterThan(1);
  });

  it('shows the DNS record and Check only for a domain that is not verified', async () => {
    const calls = routeFetch({
      [`GET ${SHIP_API}/domains`]: () =>
        json(
          domainList({
            domains: [
              domain('pending', {
                lastCheckedAt: '2026-01-01T11:00:00.000Z',
                message: 'No TXT record found.',
              }),
              domain('live', {
                hostname: 'www.example.com',
                status: 'VERIFIED',
                verifiedAt: '2026-01-01T12:00:00.000Z',
                lastCheckedAt: '2026-01-02T12:00:00.000Z',
              }),
            ],
          }),
        ),
      [`POST ${SHIP_API}/domains/pending/verify`]: () =>
        json({ domain: domain('pending', { status: 'VERIFIED' }) }),
    });
    renderDomains();

    await screen.findByText('pending.example.com');
    expect(screen.getByLabelText('DNS record for pending.example.com')).toHaveTextContent(
      '_platform-verify.pending.example.com',
    );
    expect(
      screen.getByRole('button', { name: 'Copy dns record for pending.example.com' }),
    ).toBeInTheDocument();
    expect(screen.getByText('No TXT record found.')).toBeInTheDocument();
    expect(screen.getByText('Waiting for DNS')).toBeInTheDocument();

    expect(screen.getByText('Verified')).toBeInTheDocument();
    expect(screen.queryByLabelText('DNS record for www.example.com')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Check www.example.com' })).not.toBeInTheDocument();
    expect(screen.getByText('2 of 5 custom domains.')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Check pending.example.com' }));
    await waitFor(() => expect(calls).toContain(`POST ${SHIP_API}/domains/pending/verify`));
    expect(await screen.findByText('pending.example.com is verified')).toBeInTheDocument();
  });

  it('adds a domain and shows a field error when the server refuses', async () => {
    let attempts = 0;
    routeFetch({
      [`GET ${SHIP_API}/domains`]: () => json(domainList()),
      [`POST ${SHIP_API}/domains`]: () => {
        attempts += 1;
        return attempts === 1
          ? json(
              {
                error: {
                  code: 'VALIDATION_FAILED',
                  message: 'Check the form',
                  details: {
                    fields: [{ path: 'hostname', message: 'A domain needs at least one dot' }],
                  },
                },
              },
              400,
            )
          : json({ domain: domain('new', { hostname: 'app.example.com' }) }, 201);
      },
    });
    renderDomains();

    const field = await screen.findByLabelText('Custom domain');
    await userEvent.type(field, 'nodots');
    await userEvent.click(screen.getByRole('button', { name: 'Add domain' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('A domain needs at least one dot');

    await userEvent.clear(field);
    await userEvent.type(field, 'app.example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Add domain' }));
    expect(await screen.findByText('app.example.com added')).toBeInTheDocument();
    expect(screen.getByLabelText('Custom domain')).toHaveValue('');
  });

  it('asks before removing a domain', async () => {
    const calls = routeFetch({
      [`GET ${SHIP_API}/domains`]: () => json(domainList({ domains: [domain('old')] })),
      [`DELETE ${SHIP_API}/domains/old`]: () => new Response(null, { status: 204 }),
    });
    renderDomains();

    await screen.findByText('old.example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Remove old.example.com' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Remove old.example.com?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove old.example.com' }));

    await waitFor(() => expect(calls).toContain(`DELETE ${SHIP_API}/domains/old`));
  });

  it('keeps custom domains quiet when the installation does not offer them', async () => {
    routeFetch({
      [`GET ${SHIP_API}/domains`]: () =>
        json(domainList({ unavailableReason: 'No certificate issuer is configured.' })),
    });
    renderDomains();

    expect(
      await screen.findByText('Custom domains are not available on this installation.'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('No certificate issuer is configured.').closest('[role]'),
    ).toHaveAttribute('role', 'status');
    expect(screen.queryByLabelText('Custom domain')).not.toBeInTheDocument();
  });
});
