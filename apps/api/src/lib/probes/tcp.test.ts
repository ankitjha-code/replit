import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { hostPortFromUrl, tcpProbe } from './tcp.js';

let servers: net.Server[] = [];

const listen = (): Promise<number> =>
  new Promise((resolve) => {
    const server = net.createServer();
    servers.push(server);
    server.listen(0, '127.0.0.1', () => {
      resolve((server.address() as net.AddressInfo).port);
    });
  });

afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
  servers = [];
});

describe('tcpProbe', () => {
  it('reports up when something is listening', async () => {
    const port = await listen();
    const result = await tcpProbe('probe', '127.0.0.1', port).check();
    expect(result.status).toBe('up');
    expect(result.detail).toContain('accepting connections');
  });

  it('reports down when the port is closed', async () => {
    // Bind then release, so the port is almost certainly free.
    const port = await listen();
    await new Promise((r) => servers.pop()?.close(r));

    const result = await tcpProbe('probe', '127.0.0.1', port).check();
    expect(result.status).toBe('down');
  });

  it('reports down for an unresolvable host', async () => {
    const result = await tcpProbe('probe', 'no-such-host.invalid', 5432).check();
    expect(result.status).toBe('down');
  });

  it('never leaks the connection detail into a thrown error', async () => {
    await expect(tcpProbe('probe', 'no-such-host.invalid', 1).check()).resolves.toBeDefined();
  });
});

describe('hostPortFromUrl', () => {
  it('extracts host and port from a postgres URL', () => {
    expect(hostPortFromUrl('postgresql://u:p@localhost:5442/db?schema=public', 5432)).toEqual({
      host: 'localhost',
      port: 5442,
    });
  });

  it('falls back to the default port when none is given', () => {
    expect(hostPortFromUrl('redis://cache.internal', 6379)).toEqual({
      host: 'cache.internal',
      port: 6379,
    });
  });

  it('returns undefined for a malformed URL', () => {
    expect(hostPortFromUrl('not a url', 5432)).toBeUndefined();
  });

  it('returns undefined for an out-of-range port', () => {
    expect(hostPortFromUrl('postgresql://host:99999/db', 5432)).toBeUndefined();
  });
});
