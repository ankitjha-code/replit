import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { json, operationsHandlers, renderOperations, routeFetch } from './test-helpers.js';
import { publicUser } from '../settings/test-helpers.js';

afterEach(() => vi.unstubAllGlobals());

describe('Operations shell', () => {
  it('shows every section in the sidebar and links to System status', async () => {
    routeFetch(operationsHandlers());
    renderOperations('/operations/hosts');

    await screen.findByRole('heading', { level: 1, name: 'Operations' });
    const nav = screen.getByRole('navigation', { name: 'Operations' });
    expect(Array.from(nav.querySelectorAll('a')).map((link) => link.textContent)).toEqual([
      'Overview',
      'Hosts',
      'Accounts',
      'Cleanup',
      'Audit',
    ]);
    expect(screen.getByRole('link', { name: 'Hosts' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'System status' })).toHaveAttribute('href', '/status');
    expect(document.title).toBe('Hosts · Operations · Workspace');
  });

  it('shows the shared not-found page to someone who is not an operator', async () => {
    routeFetch({ ...operationsHandlers(), 'GET /api/auth/me': () => json({ user: publicUser }) });
    renderOperations('/operations');

    expect(await screen.findByRole('heading', { level: 1, name: 'Not found' })).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Operations' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Go to your projects' })).toBeInTheDocument();
  });

  it('shows not found for a section that does not exist', async () => {
    routeFetch(operationsHandlers());
    renderOperations('/operations/nowhere');
    expect(await screen.findByRole('heading', { level: 1, name: 'Not found' })).toBeInTheDocument();
  });
});
