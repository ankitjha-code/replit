import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectVariables } from './ProjectVariables.js';

/**
 * The environment variables surface.
 *
 * The assertions here are mostly positive, which is the point: this is the
 * panel that shows values. The secrets panel next door is tested the opposite
 * way, and the pair of suites is where the difference between the two features
 * is actually pinned down.
 */

const PROJECT = '018f0000-0000-7000-8000-0000000000aa';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const variable = (key: string, value: string) => ({
  key,
  value,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
});

function mockApi(
  options: {
    variables?: unknown[];
    restartRequired?: boolean;
    putStatus?: number;
    putBody?: unknown;
  } = {},
) {
  const calls: { method: string; url: string; body: unknown }[] = [];

  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({
        method,
        url: String(input),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });

      if (method === 'PUT') {
        return Promise.resolve(
          json(
            options.putBody ?? { variable: variable('LOG_LEVEL', 'debug') },
            options.putStatus ?? 200,
          ),
        );
      }
      if (method === 'DELETE') return Promise.resolve(new Response(null, { status: 204 }));

      return Promise.resolve(
        json({
          variables: options.variables ?? [],
          limit: 100,
          restartRequired: options.restartRequired ?? false,
        }),
      );
    }),
  );

  return { calls };
}

const panel = (canWrite = true) =>
  render(<ProjectVariables projectId={PROJECT} canWrite={canWrite} />);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('showing values', () => {
  it('shows the value, which is the whole difference from a secret', async () => {
    mockApi({ variables: [variable('LOG_LEVEL', 'debug')] });
    panel();

    expect(await screen.findByText('LOG_LEVEL')).toBeInTheDocument();
    expect(screen.getByText('debug')).toBeInTheDocument();
  });

  it('names an empty value rather than drawing a blank', async () => {
    // A blank cell is indistinguishable from a value that failed to load, and
    // a variable set to nothing means something specific to most programs.
    mockApi({ variables: [variable('DEBUG', '')] });
    panel();

    expect(await screen.findByText('DEBUG')).toBeInTheDocument();
    expect(screen.getByText('empty')).toBeInTheDocument();
  });

  it('says when there are none, rather than showing an empty box', async () => {
    mockApi();
    panel();
    expect(await screen.findByText('No environment variables yet.')).toBeInTheDocument();
  });

  it('points anything damaging to read at secrets instead', async () => {
    mockApi();
    panel();
    expect(await screen.findByText(/belongs in Secrets instead/)).toBeInTheDocument();
  });
});

describe('a change that has not taken effect', () => {
  it('says the running project is using what it started with', async () => {
    // A container is handed its environment when it is created. Without this
    // someone edits a value and waits for something that will never happen.
    mockApi({ variables: [variable('PORT', '8080')], restartRequired: true });
    panel();

    expect(
      await screen.findByText(/Restart it for changes here to take effect/),
    ).toBeInTheDocument();
  });

  it('says nothing of the kind when the project is not running', async () => {
    mockApi({ variables: [variable('PORT', '8080')], restartRequired: false });
    panel();

    await screen.findByText('PORT');
    expect(screen.queryByText(/Restart it/)).not.toBeInTheDocument();
  });
});

describe('editing', () => {
  it('sends what was typed', async () => {
    const { calls } = mockApi();
    panel();
    await screen.findByText('No environment variables yet.');

    await userEvent.type(screen.getByLabelText('Variable name'), 'LOG_LEVEL');
    await userEvent.type(screen.getByLabelText('Variable value'), 'debug');
    await userEvent.click(screen.getByRole('button', { name: 'Save variable' }));

    await waitFor(() => {
      expect(calls.some((c) => c.method === 'PUT')).toBe(true);
    });
    const put = calls.find((c) => c.method === 'PUT');
    expect(put?.body).toEqual({ key: 'LOG_LEVEL', value: 'debug' });
  });

  it('upper-cases a name as it is typed, because that is the only legal shape', async () => {
    const { calls } = mockApi();
    panel();
    await screen.findByText('No environment variables yet.');

    await userEvent.type(screen.getByLabelText('Variable name'), 'log_level');
    await userEvent.type(screen.getByLabelText('Variable value'), 'debug');
    await userEvent.click(screen.getByRole('button', { name: 'Save variable' }));

    await waitFor(() => {
      expect(calls.find((c) => c.method === 'PUT')?.body).toMatchObject({ key: 'LOG_LEVEL' });
    });
  });

  it('accepts an empty value, unlike the secret form next door', async () => {
    const { calls } = mockApi();
    panel();
    await screen.findByText('No environment variables yet.');

    await userEvent.type(screen.getByLabelText('Variable name'), 'DEBUG');
    await userEvent.click(screen.getByRole('button', { name: 'Save variable' }));

    await waitFor(() => {
      expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ key: 'DEBUG', value: '' });
    });
  });

  it('puts an existing value into the form, so editing is editing', async () => {
    // Starting from empty would mean overwriting blind, which is the failing
    // of the secrets form and is only acceptable there because it has to be.
    mockApi({ variables: [variable('PORT', '8080')] });
    panel();

    await userEvent.click(await screen.findByRole('button', { name: 'Edit' }));

    expect(screen.getByLabelText('Variable name')).toHaveValue('PORT');
    expect(screen.getByLabelText('Variable value')).toHaveValue('8080');
  });

  it('removes one', async () => {
    const { calls } = mockApi({ variables: [variable('PORT', '8080')] });
    panel();

    await userEvent.click(await screen.findByRole('button', { name: 'Remove' }));

    await waitFor(() => {
      expect(calls.some((c) => c.method === 'DELETE')).toBe(true);
    });
  });
});

describe('when the server refuses', () => {
  it('shows the precise reason a name was rejected, not the general one', async () => {
    // The general message says a name cannot be used. The field-level one says
    // which rule it broke, and that is the half worth reading.
    mockApi({
      putStatus: 422,
      putBody: {
        error: {
          code: 'VALIDATION_FAILED',
          message: 'That name cannot be used',
          details: {
            fields: [{ path: 'key', message: 'Use capital letters, digits and underscores' }],
          },
        },
      },
    });
    panel();
    await screen.findByText('No environment variables yet.');

    await userEvent.type(screen.getByLabelText('Variable name'), 'X');
    await userEvent.type(screen.getByLabelText('Variable value'), 'y');
    await userEvent.click(screen.getByRole('button', { name: 'Save variable' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Use capital letters, digits and underscores',
    );
  });

  it('explains a name already taken by a secret', async () => {
    mockApi({
      putStatus: 409,
      putBody: {
        error: {
          code: 'CONFLICT',
          message:
            'That name is already used by a secret in this project. Remove the secret first, or choose another name.',
          details: { field: 'key' },
        },
      },
    });
    panel();
    await screen.findByText('No environment variables yet.');

    await userEvent.type(screen.getByLabelText('Variable name'), 'DATABASE_URL');
    await userEvent.type(screen.getByLabelText('Variable value'), 'x');
    await userEvent.click(screen.getByRole('button', { name: 'Save variable' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/already used by a secret/i);
  });
});

describe('without permission to write', () => {
  it('shows the values and offers no way to change them', async () => {
    mockApi({ variables: [variable('PORT', '8080')] });
    panel(false);

    expect(await screen.findByText('PORT')).toBeInTheDocument();
    expect(screen.getByText('8080')).toBeInTheDocument();
    expect(screen.queryByLabelText('Variable name')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument();
  });
});
