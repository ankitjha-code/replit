import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectDatabase } from './ProjectDatabase.js';

/**
 * The database panel.
 *
 * The interesting decisions are about a live credential on a page: it is shown,
 * because it is the project's own and withholding it makes the feature nearly
 * useless, and it starts hidden, so reading it is deliberate.
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

function mockApi(
  options: {
    database?: unknown;
    unavailableReason?: string | null;
    postStatus?: number;
    postBody?: unknown;
  } = {},
) {
  const calls: { method: string }[] = [];

  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET';

      // The backups panel asks separately. It is not what these tests are
      // about, so it is answered with nothing and kept out of the call log.
      if (String(input).includes('/backups')) {
        return Promise.resolve(json({ backups: [] }));
      }

      calls.push({ method });

      if (method === 'POST') {
        return Promise.resolve(
          json(
            options.postBody ?? {
              database: ready,
              restartRequired: false,
              unavailableReason: null,
            },
            options.postStatus ?? 201,
          ),
        );
      }

      return Promise.resolve(
        json({
          database: options.database ?? null,
          restartRequired: false,
          unavailableReason: options.unavailableReason ?? null,
        }),
      );
    }),
  );

  return { calls };
}

const panel = () => render(<ProjectDatabase projectId={PROJECT} />);

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
    expect(await screen.findByText('platform-userdb', { selector: 'dd' })).toBeInTheDocument();
  });
});

describe('when the installation has no server for it', () => {
  it('says why instead of offering a button that cannot work', async () => {
    mockApi({ unavailableReason: 'This installation has no database server configured.' });
    panel();

    expect(
      await screen.findByText('This installation has no database server configured.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create a database' })).not.toBeInTheDocument();
  });
});

describe('showing the connection', () => {
  it('shows the parts a tool asks for one at a time', async () => {
    mockApi({ database: ready });
    panel();

    expect(await screen.findByText('platform-userdb', { selector: 'dd' })).toBeInTheDocument();
    expect(screen.getByText('5432')).toBeInTheDocument();
    expect(screen.getByText('p_abc')).toBeInTheDocument();
    expect(screen.getByText('r_abc')).toBeInTheDocument();
  });

  it('hides the password until it is asked for', async () => {
    // Owner-only is not the same as safe to have on screen in a meeting.
    mockApi({ database: ready });
    panel();

    await screen.findByText('platform-userdb', { selector: 'dd' });
    expect(screen.queryByText('s3cr3t-p4ss')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show password' })).toBeInTheDocument();
  });

  it('keeps the password out of the URL until then too', async () => {
    mockApi({ database: ready });
    panel();

    await screen.findByText('platform-userdb', { selector: 'dd' });
    expect(screen.queryByText(/s3cr3t-p4ss/)).not.toBeInTheDocument();
    expect(screen.getByText(/postgresql:\/\/r_abc:/)).toBeInTheDocument();
  });

  it('shows it, in both forms, once asked', async () => {
    mockApi({ database: ready });
    panel();

    await userEvent.click(await screen.findByRole('button', { name: 'Show password' }));

    expect(screen.getByText('s3cr3t-p4ss')).toBeInTheDocument();
    expect(screen.getByText(connection.url)).toBeInTheDocument();
  });

  it('says where these details actually work', async () => {
    // The host is a container name. Without this somebody pastes it into a
    // client on their laptop and concludes the platform is broken.
    mockApi({ database: ready });
    panel();
    expect(await screen.findByText(/work from inside the project/)).toBeInTheDocument();
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
