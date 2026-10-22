import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './api-client.js';
import { uploadAsset } from './project-storage-api.js';

/**
 * The upload goes through XMLHttpRequest so the browser can report progress.
 * A small fake stands in for it here: it records what was sent and lets the
 * test play the events the browser would.
 */

class FakeXhr {
  static instances: FakeXhr[] = [];
  method = '';
  url = '';
  headers: Record<string, string> = {};
  body: unknown;
  withCredentials = false;
  responseType = '';
  status = 0;
  responseText = '';
  upload = new EventTarget();
  private readonly target = new EventTarget();

  constructor() {
    FakeXhr.instances.push(this);
  }
  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name: string, value: string): void {
    this.headers[name] = value;
  }
  addEventListener(type: string, listener: EventListener): void {
    this.target.addEventListener(type, listener);
  }
  send(body: unknown): void {
    this.body = body;
  }
  abort(): void {
    this.target.dispatchEvent(new Event('abort'));
  }
  /** What the browser does when the server answers. */
  respond(status: number, body: unknown): void {
    this.status = status;
    this.responseText = JSON.stringify(body);
    this.target.dispatchEvent(new Event('load'));
  }
  progress(loaded: number, total: number): void {
    const event = new Event('progress') as Event & {
      loaded: number;
      total: number;
      lengthComputable: boolean;
    };
    Object.assign(event, { loaded, total, lengthComputable: true });
    this.upload.dispatchEvent(event);
  }
  fail(): void {
    this.target.dispatchEvent(new Event('error'));
  }
}

const asset = {
  id: 'a1',
  name: 'notes.txt',
  contentType: 'text/plain',
  size: 10,
  checksum: 'abc',
  createdAt: '2026-01-01T00:00:00.000Z',
};

afterEach(() => {
  vi.unstubAllGlobals();
  FakeXhr.instances = [];
});

describe('uploadAsset', () => {
  it('posts the bytes with the name in a header and reports progress', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    const progress: Array<[number, number]> = [];
    const file = new File(['some notes'], 'notes.txt', { type: 'text/plain' });

    const pending = uploadAsset('p1', file, {
      onProgress: (sent, total) => progress.push([sent, total]),
    });
    const xhr = FakeXhr.instances[0]!;
    expect(xhr.method).toBe('POST');
    expect(xhr.url).toBe('/api/projects/p1/assets');
    expect(xhr.withCredentials).toBe(true);
    expect(xhr.headers['x-asset-name']).toBe('notes.txt');
    expect(xhr.headers['content-type']).toBe('text/plain');
    expect(xhr.body).toBe(file);

    xhr.progress(5, 10);
    xhr.respond(201, { asset });

    await expect(pending).resolves.toEqual(asset);
    expect(progress).toEqual([[5, 10]]);
  });

  it('turns a refusal into an ApiError with the server message', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    const pending = uploadAsset('p1', new File(['x'], 'big.bin'));
    FakeXhr.instances[0]!.respond(413, {
      error: { code: 'PAYLOAD_TOO_LARGE', message: 'That file is larger than the 20 MB limit' },
    });

    await expect(pending).rejects.toMatchObject({
      name: 'ApiError',
      code: 'PAYLOAD_TOO_LARGE',
      message: 'That file is larger than the 20 MB limit',
      status: 413,
    });
  });

  it('says the server could not be reached when the connection fails', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    const pending = uploadAsset('p1', new File(['x'], 'a.txt'));
    FakeXhr.instances[0]!.fail();

    await expect(pending).rejects.toBeInstanceOf(ApiError);
    await expect(pending).rejects.toMatchObject({ message: 'Could not reach the server' });
  });

  it('aborts when the signal fires', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    const controller = new AbortController();
    const pending = uploadAsset('p1', new File(['x'], 'a.txt'), { signal: controller.signal });
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});
