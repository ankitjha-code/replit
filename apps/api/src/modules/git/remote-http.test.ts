import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import { checkRemoteUrl, createRemoteHttp, isPrivateAddress } from './remote-http.js';

const strict = {
  allowInsecure: false,
  allowPrivateAddresses: false,
  maxResponseBytes: 1024,
  timeoutMs: 2_000,
};

describe('which addresses a remote may reach', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '::1',
    'fe80::1',
    'fd00::1',
    '::ffff:127.0.0.1',
  ])('refuses %s', (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  it.each(['140.82.112.3', '1.1.1.1', '2606:4700:4700::1111'])('allows %s', (address) => {
    expect(isPrivateAddress(address)).toBe(false);
  });
});

describe('which URLs a remote may be', () => {
  it('accepts https', () => {
    expect(checkRemoteUrl('https://github.com/a/b.git', strict).host).toBe('github.com');
  });

  it('refuses http unless allowed, and anything else always', () => {
    expect(() => checkRemoteUrl('http://github.com/a/b.git', strict)).toThrow(/https/);
    expect(() =>
      checkRemoteUrl('http://github.com/a/b.git', { ...strict, allowInsecure: true }),
    ).not.toThrow();
    expect(() =>
      checkRemoteUrl('file:///etc/passwd', { ...strict, allowInsecure: true }),
    ).toThrow();
    expect(() => checkRemoteUrl('ssh://git@github.com/a/b.git', strict)).toThrow();
  });

  it('refuses credentials written into the address', () => {
    expect(() => checkRemoteUrl('https://user:secret@github.com/a/b.git', strict)).toThrow(
      /own fields/,
    );
  });
});

describe('the client', () => {
  it('will not dial a private address, by literal or by name', async () => {
    const http = createRemoteHttp({ ...strict, allowInsecure: true });
    await expect(http.request({ url: 'http://127.0.0.1:9/x' })).rejects.toThrow(/private/);
    await expect(http.request({ url: 'http://localhost:9/x' })).rejects.toThrow(/private/);
    await expect(http.request({ url: 'http://[::1]:9/x' })).rejects.toThrow(/private/);
  });

  it('cuts a response off past the limit', async () => {
    const server = createServer((_req, res) => res.end(Buffer.alloc(4096)));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;

    try {
      const http = createRemoteHttp({
        ...strict,
        allowInsecure: true,
        allowPrivateAddresses: true,
      });
      const response = await http.request({ url: `http://127.0.0.1:${port}/` });
      const read = async () => {
        for await (const _ of response.body!) void _;
      };
      await expect(read()).rejects.toThrow(/more than/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
