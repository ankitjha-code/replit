import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import {
  NavigationGuardProvider,
  useGuardedNavigate,
  useNavigationGuard,
  useRegisterGuard,
} from './navigation-guard.js';

function Editor({ dirty, flush }: { dirty: boolean; flush: () => Promise<void> }) {
  useRegisterGuard('editor', {
    isDirty: () => dirty,
    flush,
    describe: () => 'index.js has unsaved changes',
  });
  return <p>editor</p>;
}

function Nav() {
  const go = useGuardedNavigate();
  return (
    <button type="button" onClick={() => void go('/projects')}>
      Projects
    </button>
  );
}

function Where() {
  return <p>at {useLocation().pathname}</p>;
}

function App({ dirty, flush }: { dirty: boolean; flush: () => Promise<void> }) {
  return (
    <MemoryRouter initialEntries={['/workspace']}>
      <NavigationGuardProvider>
        <Nav />
        <Where />
        <Routes>
          <Route path="/workspace" element={<Editor dirty={dirty} flush={flush} />} />
          <Route path="/projects" element={<p>projects list</p>} />
        </Routes>
      </NavigationGuardProvider>
    </MemoryRouter>
  );
}

describe('navigation guard', () => {
  it('navigates at once when nothing is dirty', async () => {
    const user = userEvent.setup();
    render(<App dirty={false} flush={() => Promise.resolve()} />);
    await user.click(screen.getByRole('button', { name: 'Projects' }));
    expect(await screen.findByText('at /projects')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('asks, and Cancel stays put', async () => {
    const user = userEvent.setup();
    render(<App dirty flush={() => Promise.resolve()} />);
    await user.click(screen.getByRole('button', { name: 'Projects' }));
    const dialog = await screen.findByRole('dialog', { name: 'You have unsaved changes' });
    expect(dialog).toHaveTextContent('index.js has unsaved changes');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByText('at /workspace')).toBeInTheDocument();
  });

  it('Leave without saving proceeds without flushing', async () => {
    const user = userEvent.setup();
    const flush = vi.fn(() => Promise.resolve());
    render(<App dirty flush={flush} />);
    await user.click(screen.getByRole('button', { name: 'Projects' }));
    await user.click(await screen.findByRole('button', { name: 'Leave without saving' }));
    expect(await screen.findByText('at /projects')).toBeInTheDocument();
    expect(flush).not.toHaveBeenCalled();
  });

  it('Save and leave flushes first, and a failed save keeps the person here', async () => {
    const user = userEvent.setup();
    const flush = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('Could not reach the server'))
      .mockResolvedValueOnce(undefined);
    render(<App dirty flush={flush} />);
    await user.click(screen.getByRole('button', { name: 'Projects' }));
    await user.click(await screen.findByRole('button', { name: 'Save and leave' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not reach the server');
    expect(screen.getByText('at /workspace')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Save and leave' }));
    expect(await screen.findByText('at /projects')).toBeInTheDocument();
    expect(flush).toHaveBeenCalledTimes(2);
  });

  it('is permissive without a provider so existing harnesses are not blocked', async () => {
    function Probe() {
      const { confirmLeave, hasDirty } = useNavigationGuard();
      const [decision, setDecision] = useState('');
      return (
        <button type="button" onClick={() => void confirmLeave().then(setDecision)}>
          {decision || String(hasDirty())}
        </button>
      );
    }
    const user = userEvent.setup();
    render(<Probe />);
    await user.click(screen.getByRole('button', { name: 'false' }));
    expect(await screen.findByRole('button', { name: 'proceed' })).toBeInTheDocument();
  });

  it('removes a guard when its component unmounts', async () => {
    const user = userEvent.setup();
    function Toggle() {
      const [mounted, setMounted] = useState(true);
      return (
        <>
          {mounted && <Editor dirty flush={() => Promise.resolve()} />}
          <button type="button" onClick={() => setMounted(false)}>
            Close editor
          </button>
        </>
      );
    }
    render(
      <MemoryRouter>
        <NavigationGuardProvider>
          <Nav />
          <Where />
          <Toggle />
        </NavigationGuardProvider>
      </MemoryRouter>,
    );
    await user.click(screen.getByRole('button', { name: 'Close editor' }));
    await user.click(screen.getByRole('button', { name: 'Projects' }));
    expect(await screen.findByText('at /projects')).toBeInTheDocument();
  });
});
