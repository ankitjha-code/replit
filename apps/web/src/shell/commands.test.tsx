import { act, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../lib/auth-context.js';
import type { StarterId } from '../lib/starter-templates.js';
import { useCreateProjectRequest } from '../routes/projects/create-project-request.js';
import type { PaletteCommand } from '../ui/index.js';
import { useGlobalCommands } from './commands.js';

const publicUser = {
  id: '018f0000-0000-7000-8000-000000000001',
  email: 'ada@example.test',
  username: 'ada',
  displayName: null,
  emailVerified: true,
  isOperator: false,
  createdAt: '2026-01-01T00:00:00.000Z',
};

let commands: PaletteCommand[] = [];

function Palette(): null {
  commands = useGlobalCommands();
  return null;
}

function Home(): React.JSX.Element {
  const [requested, setRequested] = useState<StarterId | undefined>();
  useCreateProjectRequest(setRequested);
  return <p>{requested ? `Create dialog: ${requested}` : 'Your projects'}</p>;
}

afterEach(() => vi.unstubAllGlobals());

describe('useGlobalCommands', () => {
  it('"New project" goes to the list and opens the create dialog there', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ user: publicUser }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        ),
      ),
    );
    render(
      <AuthProvider>
        <MemoryRouter initialEntries={['/account']}>
          <Palette />
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/account" element={<h1>Account</h1>} />
          </Routes>
        </MemoryRouter>
      </AuthProvider>,
    );

    await waitFor(() => expect(commands.some((c) => c.id === 'new-project')).toBe(true));
    const create = commands.find((c) => c.id === 'new-project')!;
    expect(create.label).toBe('New project');

    act(() => create.onSelect());

    expect(await screen.findByText('Create dialog: blank')).toBeInTheDocument();
  });
});
