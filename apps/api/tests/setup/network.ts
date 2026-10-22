import http from 'node:http';
import https from 'node:https';
import request from 'supertest';

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

http.globalAgent = new http.Agent({ keepAlive: false });
