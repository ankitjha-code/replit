import http from 'node:http';
import https from 'node:https';
import request from 'supertest';

/**
 * Makes every test request reach the server it was meant for.
 *
 * Supertest starts a throwaway server per request with `listen(0)`, which binds
 * every address, and then connects to it at 127.0.0.1. macOS lets a
 * loopback-specific binding share a port number with a wildcard one, and
 * delivers a request for 127.0.0.1 to the specific one. Docker Desktop holds
 * exactly such bindings — one per port it publishes for a container — on random
 * high ports, the same range `listen(0)` draws from. So now and then a test's
 * request went to a container's published port instead of the test's server:
 * a `socket hang up`, an aborted request body, or a status from something the
 * test had never heard of, in a different test on most full runs, and more
 * often the more containers were running.
 *
 * Supertest is pointed at the IPv6 loopback instead. Its wildcard server is
 * reachable there, and nothing publishes IPv4-only loopback ports into it.
 * (On Linux, where the platform publishes nothing, this never happened.)
 */
/**
 * macOS only: that is where a specific listener can shadow a wildcard one, and
 * a Linux runner is not guaranteed to have an IPv6 loopback at all.
 */
const LOOPBACK = process.platform === 'darwin' ? '[::1]' : '127.0.0.1';

type SupertestTest = {
  prototype: { serverAddress(app: http.Server, path: string): string; _server?: http.Server };
};
const Test = (request as unknown as { Test: SupertestTest }).Test;

Test.prototype.serverAddress = function serverAddress(
  this: { _server?: http.Server },
  app: http.Server,
  path: string,
): string {
  if (!app.address()) this._server = app.listen(0);
  const address = app.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const protocol = app instanceof https.Server ? 'https' : 'http';
  return `${protocol}://${LOOPBACK}:${String(port)}${path}`;
};

/**
 * No connection reuse between test requests either: each request's server is
 * gone a moment later, and a pooled connection to it is only a way to be
 * surprised.
 */
http.globalAgent = new http.Agent({ keepAlive: false });
