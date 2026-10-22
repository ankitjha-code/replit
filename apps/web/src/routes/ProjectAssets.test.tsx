import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../lib/api-client.js';
import type * as StorageApi from '../lib/project-storage-api.js';
import { uploadAsset } from '../lib/project-storage-api.js';
import { ProjectAssets } from './ProjectAssets.js';

/**
 * The assets surface: files that are not source, uploaded with progress and
 * downloaded again. The upload itself goes through XMLHttpRequest, which the
 * API module's own test covers; here it is replaced so the panel's behaviour
 * around it can be read.
 */

vi.mock('../lib/project-storage-api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof StorageApi>();
  return { ...actual, uploadAsset: vi.fn() };
});

const PROJECT = '018f0000-0000-7000-8000-0000000000aa';
const LIMIT = 250 * 1024 * 1024;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const asset = (name: string, size = 1024) => ({
  id: `asset-${name}`,
  name,
  contentType: 'text/plain',
  size,
  checksum: 'abc',
  createdAt: '2026-01-02T00:00:00.000Z',
});

function mockApi(options: { assets?: ReturnType<typeof asset>[]; totalBytes?: number } = {}) {
  const calls: { method: string; url: string }[] = [];
  const state = { assets: [...(options.assets ?? [])] };

  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const url = String(input);
      calls.push({ method, url });
      if (method === 'DELETE') {
        state.assets = state.assets.filter((item) => !url.endsWith(item.id));
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      return Promise.resolve(
        json({
          assets: state.assets,
          totalBytes:
            options.totalBytes ?? state.assets.reduce((total, item) => total + item.size, 0),
          limitBytes: LIMIT,
        }),
      );
    }),
  );

  const upload = vi.mocked(uploadAsset);
  upload.mockImplementation(async (_projectId, file, uploadOptions) => {
    uploadOptions?.onProgress?.(file.size, file.size);
    const made = asset(file.name, file.size);
    state.assets = [...state.assets, made];
    return made;
  });

  return { calls, upload };
}

const panel = (canWrite = true) =>
  render(<ProjectAssets projectId={PROJECT} canWrite={canWrite} />);

beforeEach(() => {
  vi.mocked(uploadAsset).mockReset();
});
afterEach(() => vi.unstubAllGlobals());

describe('what the page shows', () => {
  it('is called Assets and says when there are none', async () => {
    mockApi();
    panel();

    expect(screen.getByRole('heading', { level: 2, name: 'Assets' })).toBeInTheDocument();
    expect(await screen.findByText('No assets yet.')).toBeInTheDocument();
  });

  it('lists files with their size and a download link', async () => {
    mockApi({ assets: [asset('notes.txt', 2048)] });
    panel();

    expect(await screen.findByText('notes.txt')).toBeInTheDocument();
    expect(screen.getByText('2.0 kB')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: 'Download notes.txt' });
    expect(link).toHaveAttribute('href', `/api/projects/${PROJECT}/assets/asset-notes.txt/content`);
    expect(link).toHaveAttribute('download', 'notes.txt');
  });

  it('shows how much of the storage is used', async () => {
    mockApi({ assets: [asset('a.bin', 1024 * 1024)] });
    panel();

    const meter = await screen.findByRole('meter', { name: 'Storage used' });
    expect(meter).toHaveAttribute('aria-valuetext', '1.0 MB of 250 MB');
  });

  it('shows the failure with a retry when the list cannot be read', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          json({ error: { code: 'INTERNAL_ERROR', message: 'Storage is unavailable' } }, 500),
        ),
      ),
    );
    panel();
    expect(await screen.findByText('Storage is unavailable')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});

describe('uploading', () => {
  it('sends every chosen file, one after another, and lists them', async () => {
    const { upload } = mockApi();
    panel();
    await screen.findByText('No assets yet.');

    const input = screen.getByLabelText('Upload a file');
    expect(input).toHaveAttribute('multiple');
    await userEvent.upload(input, [
      new File(['one'], 'one.txt', { type: 'text/plain' }),
      new File(['two'], 'two.txt', { type: 'text/plain' }),
    ]);

    await waitFor(() => expect(upload).toHaveBeenCalledTimes(2));
    expect(upload.mock.calls[0]?.[1].name).toBe('one.txt');
    expect(upload.mock.calls[1]?.[1].name).toBe('two.txt');
    expect(await screen.findByText('one.txt')).toBeInTheDocument();
    expect(screen.getByText('two.txt')).toBeInTheDocument();
  });

  it('keeps a failed upload on screen with its reason until dismissed', async () => {
    const { upload } = mockApi();
    upload.mockRejectedValue(
      new ApiError('PAYLOAD_TOO_LARGE', 'That file is larger than the 20 MB limit', 413),
    );
    panel();
    await screen.findByText('No assets yet.');

    await userEvent.upload(
      screen.getByLabelText('Upload a file'),
      new File(['x'], 'huge.bin', { type: 'application/octet-stream' }),
    );

    const list = await screen.findByRole('list', { name: 'Uploads in progress' });
    expect(within(list).getByText('That file is larger than the 20 MB limit')).toBeInTheDocument();
    await userEvent.click(within(list).getByRole('button', { name: 'Dismiss huge.bin' }));
    expect(screen.queryByRole('list', { name: 'Uploads in progress' })).not.toBeInTheDocument();
  });

  it('refuses more when the storage is full, and says so', async () => {
    mockApi({ assets: [asset('big.bin', LIMIT)], totalBytes: LIMIT });
    panel();

    await screen.findByText('big.bin');
    // Said twice on purpose: in the warning, and as the upload control's reason.
    expect(screen.getAllByText(/used all of its 250 MB/).length).toBeGreaterThan(0);
    expect(screen.getByLabelText('Upload a file')).toBeDisabled();
  });
});

describe('removing', () => {
  it('asks first, then removes by id', async () => {
    const { calls } = mockApi({ assets: [asset('temporary.txt')] });
    panel();

    await userEvent.click(await screen.findByRole('button', { name: 'Remove temporary.txt' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Remove temporary.txt?' });
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);

    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove temporary.txt' }));

    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE')).toBe(true));
    expect(calls.find((c) => c.method === 'DELETE')?.url).toContain('/assets/asset-temporary.txt');
    expect(await screen.findByText('No assets yet.')).toBeInTheDocument();
  });
});

describe('without permission to write', () => {
  it('can download but not upload or remove', async () => {
    mockApi({ assets: [asset('notes.txt')] });
    panel(false);

    expect(await screen.findByRole('link', { name: 'Download notes.txt' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Upload a file')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove notes.txt' })).not.toBeInTheDocument();
  });
});
