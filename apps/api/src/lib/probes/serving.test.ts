import { createServer, type Server } from 'node:http';
import { createServer as createTcpServer, type Server as TcpServer, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { isServingHttp } from './http.js';

/**
 * Whether something is actually serving on a port.
 *
 * The distinction this file exists for: a container runtime publishes a port by
 * binding it on the host, and that binding accepts connections whether or not
 * anything inside is listening. A preview built on "the connection succeeded"
 * shows a browser error page and blames the platform for it.
 */

const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  while (closers.length > 0) await closers.pop()!();
});

function track(server: Server | TcpServer): Promise<number> {
  // One of these servers deliberately holds a connection open in silence, and
  // `close` waits for it for ever. Only the HTTP server can drop its own
  // sockets, so they are collected here for both.
  const sockets = new Set<Socket>();
  server.on('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  closers.push(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  );
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(typeof address === 'object' && address ? address.port : 0);
    });
  });
}

describe('finding something that serves', () => {
  it('says yes when an application answers', async () => {
    const port = await track(
      createServer((_req, res) => {
        res.writeHead(200);
        res.end('hello');
      }),
    );

    expect(await isServingHttp('127.0.0.1', port)).toBe(true);
  });

  it('says yes when it answers with an error', async () => {
    // The question is whether something is there, not whether it is happy. A
    // development server showing its own error page is still a preview.
    const port = await track(
      createServer((_req, res) => {
        res.writeHead(500);
        res.end('broken');
      }),
    );

    expect(await isServingHttp('127.0.0.1', port)).toBe(true);
  });

  it('says no when the connection is accepted and nothing answers', async () => {
    // Exactly what a published container port does when the container is
    // empty. A plain connect would call this a running application.
    const port = await track(createTcpServer((socket) => socket.destroy()));

    expect(await isServingHttp('127.0.0.1', port)).toBe(false);
  });

  it('says no when the connection is accepted and held open in silence', async () => {
    const port = await track(createTcpServer(() => undefined));

    expect(await isServingHttp('127.0.0.1', port, 300)).toBe(false);
  });

  it('says no when nothing is on the port at all', async () => {
    // Port 1 on loopback, which nothing sensible binds.
    expect(await isServingHttp('127.0.0.1', 1, 300)).toBe(false);
  });

  it('gives up within its own timeout', async () => {
    const port = await track(createTcpServer(() => undefined));

    const started = Date.now();
    await isServingHttp('127.0.0.1', port, 200);

    // Generously bounded: the point is that it returns, not that it is fast.
    expect(Date.now() - started).toBeLessThan(3_000);
  });
});
