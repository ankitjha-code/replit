import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../lib/api-client.js';
import { clearToasts } from '../../ui/index.js';
import { entry, mockApi, renderPanel } from './test-helpers.js';
import { UPLOAD_MAX_BYTES, describeUpload, planUpload, uploadAll } from './upload.js';

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  clearToasts();
});

const file = (name: string, content = 'hi', size?: number): File => {
  const made = new File([content], name, { type: 'text/plain' });
  if (size !== undefined) Object.defineProperty(made, 'size', { value: size });
  return made;
};

describe('planning an upload', () => {
  it('places files in the chosen folder', () => {
    const plan = planUpload([file('a.txt'), file('b.png')], 'assets');
    expect(plan.items.map((item) => item.path)).toEqual(['assets/a.txt', 'assets/b.png']);
    expect(plan.refused).toEqual([]);
  });

  it('refuses a file too large for one request, saying why', () => {
    const plan = planUpload([file('big.bin', 'x', UPLOAD_MAX_BYTES + 1), file('ok.txt')], '');
    expect(plan.items.map((item) => item.path)).toEqual(['ok.txt']);
    expect(plan.refused).toEqual([
      { name: 'big.bin', reason: 'Larger than 1.0 MB, the most one upload can carry.' },
    ]);
  });
});

describe('sending', () => {
  it('sends one at a time, reports progress, and keeps going after a failure', async () => {
    const progress: Array<[number, number, string | undefined]> = [];
    const send = vi.fn((item: { path: string }) =>
      item.path === 'b.txt'
        ? Promise.reject(new ApiError('VALIDATION_FAILED', 'Too big', 400))
        : Promise.resolve(),
    );

    const outcome = await uploadAll(
      [
        { path: 'a.txt', file: file('a.txt') },
        { path: 'b.txt', file: file('b.txt') },
        { path: 'c.txt', file: file('c.txt') },
      ],
      send,
      (done, total, current) => progress.push([done, total, current]),
    );

    expect(outcome).toEqual({
      uploaded: ['a.txt', 'c.txt'],
      failed: [{ name: 'b.txt', reason: 'Too big' }],
    });
    expect(progress).toEqual([
      [0, 3, 'a.txt'],
      [1, 3, 'b.txt'],
      [2, 3, 'c.txt'],
      [3, 3, undefined],
    ]);
  });

  it('describes the result in one toast', () => {
    expect(describeUpload({ uploaded: ['src/a.txt'], failed: [] }, [])).toEqual({
      tone: 'success',
      title: 'Uploaded a.txt',
    });
    expect(
      describeUpload({ uploaded: ['a', 'b'], failed: [{ name: 'c', reason: 'Too big' }] }, []),
    ).toEqual({ tone: 'warn', title: 'Uploaded 2 files', description: 'c: Too big' });
    expect(
      describeUpload({ uploaded: [], failed: [] }, [{ name: 'x', reason: 'Too big' }]),
    ).toEqual({ tone: 'danger', title: 'x was not uploaded', description: 'Too big' });
  });
});

describe('uploading from the panel', () => {
  const picker = (container: HTMLElement) =>
    container.querySelector<HTMLInputElement>('input[type="file"]')!;

  it('opens the device picker from the toolbar', async () => {
    mockApi([entry('a.ts')]);
    const user = userEvent.setup();
    const { container } = renderPanel();
    await screen.findByText('a.ts');

    const click = vi.spyOn(picker(container), 'click');
    await user.click(screen.getByRole('button', { name: 'Upload files' }));
    expect(click).toHaveBeenCalled();
  });

  it('stores chosen files as base64 and says so', async () => {
    const api = mockApi([]);
    const user = userEvent.setup();
    const { container, onFilesChanged } = renderPanel();
    await screen.findByText('No files yet');

    await user.upload(picker(container), [file('notes.txt', 'hello')]);

    await waitFor(() =>
      expect(api.calls.find((call) => call.method === 'PUT')?.body).toEqual({
        path: 'notes.txt',
        content: btoa('hello'),
        encoding: 'base64',
      }),
    );
    expect(await screen.findByText('Uploaded notes.txt')).toBeInTheDocument();
    expect(onFilesChanged).toHaveBeenCalled();
  });

  it('asks before replacing a file that is already there', async () => {
    const api = mockApi([entry('notes.txt')]);
    const user = userEvent.setup();
    const { container } = renderPanel();
    await screen.findByText('notes.txt');

    await user.upload(picker(container), [file('notes.txt')]);
    const dialog = await screen.findByRole('alertdialog', { name: 'Replace existing files?' });
    expect(api.calls.filter((call) => call.method === 'PUT')).toHaveLength(0);

    await user.click(within(dialog).getByRole('button', { name: 'Replace notes.txt' }));
    await waitFor(() => expect(api.calls.filter((call) => call.method === 'PUT')).toHaveLength(1));
  });

  it('uploads files dropped on a folder into that folder', async () => {
    const api = mockApi([entry('assets', 'DIRECTORY')]);
    renderPanel();
    const folder = await screen.findByRole('treeitem', { name: 'assets' });

    const dataTransfer = { types: ['Files'], files: [file('logo.svg')], items: [], dropEffect: '' };
    fireEvent.dragOver(folder, { dataTransfer });
    fireEvent.drop(folder, { dataTransfer });

    await waitFor(() =>
      expect(api.calls.find((call) => call.method === 'PUT')?.body).toMatchObject({
        path: 'assets/logo.svg',
        encoding: 'base64',
      }),
    );
  });

  it('refuses an oversized file without sending anything', async () => {
    const api = mockApi([]);
    const user = userEvent.setup();
    const { container } = renderPanel();
    await screen.findByText('No files yet');

    await user.upload(picker(container), [file('huge.zip', 'x', UPLOAD_MAX_BYTES + 1)]);

    expect(await screen.findByText('huge.zip was not uploaded')).toBeInTheDocument();
    expect(api.calls.filter((call) => call.method === 'PUT')).toHaveLength(0);
  });
});
