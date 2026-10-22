import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectDatabase } from './ProjectDatabase.js';

/**
 * The database panel.
 *
 * The interesting decisions are about a live credential on a page: it is shown,
 * because it is the project's own and withholding it makes the feature nearly
 * useless, and it starts hidden, so reading it is deliberate. Everything that
 * destroys data asks first.
 */

const PROJECT = '018f0000-0000-7000-8000-0000000000aa';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const connection = {
  url: 'postgresql://r_abc:s3cr3t-p4ss@platform-userdb:5432/p_abc',
  host: 'platform-userdb',
  port: 5432,
  database: 'p_abc',
  username: 'r_abc',
  password: 's3cr3t-p4ss',
};

const ready = {
  status: 'READY' as const,
  createdAt: '2026-01-01T00:00:00.000Z',
  sizeBytes: null,
  message: null,
  connection,
};

const rotated = {
  ...ready,
  connection: {
    ...connection,
    password: 'new-pass',
    url: 'postgresql://r_abc:new-pass@platform-userdb:5432/p_abc',
  },
};

const backup = (id: string, note: string, status: 'READY' | 'RUNNING' | 'FAILED' = 'READY') => ({
  id,
  status,
  note,
  sizeBytes: status === 'READY' ? 2048 : null,
  message: status === 'FAILED' ? 'pg_dump exited with code 1' : null,
  createdAt: '2026-01-03T00:00:00.000Z',
  createdBy: 'ada',
  completedAt: status === 'RUNNING' ? null : '2026-01-03T00:01:00.000Z',
});

const noRuntime = {
  runtime: null,
  detected: null,
  provider: { name: 'none', available: false, reason: 'No execution backend.' },
};

/**
 * A stateful fake: creating, rotating, resetting and deleting change what the
 * next read returns, as the real server does, so the page can be checked
 * against its own reload rather than against a frozen answer.
 */
function mockApi(
  options: {
    database?: unknown;
    /** Returned by the reads in order; the last one repeats. */
    databases?: unknown[];
    unavailableReason?: string | null;
    backups?: unknown[];
    postStatus?: number;
    postBody?: unknown;
  } = {},
) {
  const calls: { method: string; url: string; body: unknown }[] = [];
  const state = {
    database: options.database ?? null,
    backups: [...(options.backups ?? [])],
    reads: 0,
  };

  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const url = String(input);
      calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });

      if (url.includes('/runtime')) return Promise.resolve(json(noRuntime));

      if (url.includes('/backups')) {
        if (method === 'POST') {
          const made = backup(
            'b-new',
            (init?.body && JSON.parse(String(init.body)).note) || 'new',
            'RUNNING',
          );
          state.backups = [made, ...state.backups];
          return Promise.resolve(json({ backup: made }, 201));
        }
        if (method === 'DELETE') {
          state.backups = state.backups.filter(
            (item) => !url.endsWith((item as { id: string }).id),
          );
          return Promise.resolve(new Response(null, { status: 204 }));
        }
        if (url.endsWith('/restore')) return Promise.resolve(json({ restored: true }));
        return Promise.resolve(json({ backups: state.backups }));
      }

      const envelope = (database: unknown) => ({
        database,
        restartRequired: false,
        unavailableReason: options.unavailableReason ?? null,
      });

      if (method === 'POST' && url.endsWith('/database')) {
        if (options.postBody !== undefined) {
          return Promise.resolve(json(options.postBody, options.postStatus ?? 201));
        }
        state.database = ready;
        return Promise.resolve(json(envelope(ready), 201));
      }
      if (method === 'POST' && url.endsWith('/rotate')) {
        state.database = rotated;
        return Promise.resolve(json(envelope(rotated)));
      }
      if (method === 'POST' && url.endsWith('/reset')) {
        return Promise.resolve(json(envelope(state.database)));
      }
      if (method === 'DELETE') {
        state.database = null;
        return Promise.resolve(json(envelope(null)));
      }

      if (options.databases) {
        const next = options.databases[Math.min(state.reads, options.databases.length - 1)];
        state.reads += 1;
        return Promise.resolve(json(envelope(next)));
      }
      return Promise.resolve(json(envelope(state.database)));
    }),
  );

  return { calls };
}

const panel = () => render(<ProjectDatabase projectId={PROJECT} />);

/**
 * The host appears twice: in the sentence saying where it resolves and in the
 * facts list. The facts list is the one tests mean, and it is still a `<dd>`.
 */
async function hostFact(): Promise<HTMLElement> {
  const matches = await screen.findAllByText('platform-userdb');
  const fact = matches.find((element) => element.closest('dd'));
  if (!fact) throw new Error('The host is not in the facts list');
  return fact;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('with no database', () => {
  it('says so and offers to make one', async () => {
    mockApi();
    panel();
    expect(await screen.findByText('This project has no database.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create a database' })).toBeInTheDocument();
  });

  it('creates one when asked', async () => {
    const { calls } = mockApi();
    panel();
    await userEvent.click(await screen.findByRole('button', { name: 'Create a database' }));

    await waitFor(() => {
      expect(calls.some((c) => c.method === 'POST')).toBe(true);
    });
    // Still a definition list: "Host" is the term and this is its value.
    expect(await hostFact()).toBeInTheDocument();
  });

  it('shows the refusal and keeps the button when creating fails', async () => {
    mockApi({
      postStatus: 503,
      postBody: { error: { code: 'STORAGE_FAILED', message: 'The database server is down' } },
    });
    panel();
    await userEvent.click(await screen.findByRole('button', { name: 'Create a database' }));

    expect(await screen.findByText('The database server is down')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create a database' })).toBeInTheDocument();
  });
});

describe('when the installation has no server for it', () => {
  it('says why, as information, instead of offering a button that cannot work', async () => {
    mockApi({ unavailableReason: 'This installation has no database server configured.' });
    panel();

    const note = await screen.findByText('This installation has no database server configured.');
    expect(note.closest('[role="status"]')).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Create a database' })).not.toBeInTheDocument();
  });
});

describe('while it is being created', () => {
  it('says so and reads again until it is ready', async () => {
    const creating = { ...ready, status: 'CREATING' as const, connection: null };
    const { calls } = mockApi({ databases: [creating, ready] });
    panel();

    expect(await screen.findByText(/being created/)).toBeInTheDocument();
    await waitFor(
      () => {
        expect(calls.filter((c) => c.method === 'GET' && c.url.endsWith('/database')).length).toBe(
          2,
        );
      },
      { timeout: 5_000 },
    );
    expect(await hostFact()).toBeInTheDocument();
  }, 10_000);
});

describe('showing the connection', () => {
  it('shows the parts a tool asks for one at a time, each with a copy button', async () => {
    mockApi({ database: ready });
    panel();

    expect(await hostFact()).toBeInTheDocument();
    expect(screen.getByText('5432').closest('dd')).not.toBeNull();
    expect(screen.getByText('p_abc')).toBeInTheDocument();
    expect(screen.getByText('r_abc')).toBeInTheDocument();
    for (const name of ['host', 'port', 'database', 'user', 'password', 'connection url']) {
      expect(screen.getByRole('button', { name: `Copy ${name}` })).toBeInTheDocument();
    }
  });

  it('hides the password until it is asked for', async () => {
    // Owner-only is not the same as safe to have on screen in a meeting.
    mockApi({ database: ready });
    panel();

    await hostFact();
    expect(screen.queryByText('s3cr3t-p4ss')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show password' })).toBeInTheDocument();
  });

  it('keeps the password out of the URL until then too', async () => {
    mockApi({ database: ready });
    panel();

    await hostFact();
    expect(screen.queryByText(/s3cr3t-p4ss/)).not.toBeInTheDocument();
    expect(screen.getByText(/postgresql:\/\/r_abc:/)).toBeInTheDocument();
  });

  it('shows it, in both forms, once asked', async () => {
    mockApi({ database: ready });
    panel();

    await userEvent.click(await screen.findByRole('button', { name: 'Show password' }));

    expect(screen.getByText('s3cr3t-p4ss')).toBeInTheDocument();
    expect(screen.getByText(connection.url)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Hide password' })).toBeInTheDocument();
  });

  it('says where these details actually work', async () => {
    // The host is a container name. Without this somebody pastes it into a
    // client on their laptop and concludes the platform is broken.
    mockApi({ database: ready });
    panel();
    expect(await screen.findByText(/work from inside the project/)).toBeInTheDocument();
  });
});

describe('changing the password', () => {
  it('asks first, then shows the new password at once', async () => {
    const { calls } = mockApi({ database: ready });
    panel();
    await hostFact();

    await userEvent.click(screen.getByRole('button', { name: 'Change password' }));
    const dialog = await screen.findByRole('alertdialog', {
      name: 'Change the database password?',
    });
    expect(calls.some((c) => c.url.endsWith('/rotate'))).toBe(false);

    await userEvent.click(within(dialog).getByRole('button', { name: 'Change password' }));

    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/rotate'))).toBe(true));
    // A password nobody has seen is shown rather than hidden behind the toggle.
    expect(await screen.findByText('new-pass')).toBeInTheDocument();
  });
});

describe('destroying data', () => {
  it('empties only after the word is typed', async () => {
    const { calls } = mockApi({ database: ready });
    panel();
    await hostFact();

    await userEvent.click(screen.getByRole('button', { name: 'Empty database' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Empty this database?' });
    expect(within(dialog).getByRole('button', { name: 'Empty database' })).toBeDisabled();

    await userEvent.type(within(dialog).getByLabelText(/Type .* to confirm/), 'empty');
    // Queried again: the button is re-rendered without its disabled wrapper.
    await userEvent.click(within(dialog).getByRole('button', { name: 'Empty database' }));

    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/reset'))).toBe(true));
  });

  it('deletes only after the word is typed, then shows there is none', async () => {
    const { calls } = mockApi({ database: ready });
    panel();
    await hostFact();

    await userEvent.click(screen.getByRole('button', { name: 'Delete database' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Delete this database?' });
    await userEvent.type(within(dialog).getByLabelText(/Type .* to confirm/), 'delete');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete database' }));

    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE')).toBe(true));
    expect(await screen.findByText('This project has no database.')).toBeInTheDocument();
  });
});

describe('when it went wrong', () => {
  it('shows the reason and offers another attempt', async () => {
    mockApi({
      database: {
        status: 'FAILED',
        createdAt: '2026-01-01T00:00:00.000Z',
        sizeBytes: null,
        message: 'The database could not be created.',
        connection: null,
      },
    });
    panel();

    expect(await screen.findByText('The database could not be created.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('says plainly when a credential can no longer be decrypted', async () => {
    mockApi({
      database: { ...ready, connection: null },
    });
    panel();

    expect(await screen.findByText(/could not be read/)).toBeInTheDocument();
  });
});

describe('backups', () => {
  it('lists them with their size and who took them', async () => {
    mockApi({ database: ready, backups: [backup('b1', 'Before the migration')] });
    panel();

    expect(await screen.findByText('Before the migration')).toBeInTheDocument();
    expect(screen.getByText('2.0 kB')).toBeInTheDocument();
    expect(screen.getByText(/by ada/)).toBeInTheDocument();
  });

  it('says when there are none', async () => {
    mockApi({ database: ready });
    panel();
    expect(await screen.findByText('No backups yet.')).toBeInTheDocument();
  });

  it('takes one with the note typed', async () => {
    const { calls } = mockApi({ database: ready });
    panel();
    await screen.findByText('No backups yet.');

    await userEvent.type(screen.getByLabelText('Backup note'), 'Friday');
    await userEvent.click(screen.getByRole('button', { name: 'Take a backup' }));

    await waitFor(() => {
      expect(calls.find((c) => c.method === 'POST' && c.url.endsWith('/backups'))?.body).toEqual({
        note: 'Friday',
      });
    });
    expect(await screen.findByText('Friday')).toBeInTheDocument();
    expect(screen.getByText('Being taken')).toBeInTheDocument();
  });

  it('cannot restore or remove a backup that is still being taken', async () => {
    mockApi({ database: ready, backups: [backup('b1', 'Running one', 'RUNNING')] });
    panel();

    await screen.findByText('Running one');
    expect(screen.getByRole('button', { name: 'Restore Running one' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Remove backup Running one' })).toBeDisabled();
  });

  it('restores only after confirming, saying what is lost', async () => {
    const { calls } = mockApi({ database: ready, backups: [backup('b1', 'Monday')] });
    panel();

    await userEvent.click(await screen.findByRole('button', { name: 'Restore Monday' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Restore the backup Monday?' });
    expect(within(dialog).getByText(/deleted and replaced/)).toBeInTheDocument();
    expect(calls.some((c) => c.url.endsWith('/restore'))).toBe(false);

    await userEvent.click(within(dialog).getByRole('button', { name: 'Restore Monday' }));

    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/b1/restore'))).toBe(true));
  });

  it('removes one only after confirming', async () => {
    const { calls } = mockApi({ database: ready, backups: [backup('b1', 'Monday')] });
    panel();

    await userEvent.click(await screen.findByRole('button', { name: 'Remove backup Monday' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Remove the backup Monday?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove backup Monday' }));

    await waitFor(() => {
      expect(calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/backups/b1'))).toBe(true);
    });
    expect(await screen.findByText('No backups yet.')).toBeInTheDocument();
  });

  it('shows a failed backup with its reason', async () => {
    mockApi({ database: ready, backups: [backup('b1', 'Broken', 'FAILED')] });
    panel();

    expect(await screen.findByText('Broken')).toBeInTheDocument();
    expect(screen.getByText('Failed')).toBeInTheDocument();
    expect(screen.getByText('pg_dump exited with code 1')).toBeInTheDocument();
  });
});
