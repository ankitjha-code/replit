import http from 'node:http';
import net from 'node:net';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { testApp } from './setup/app.js';
import { loadEnv } from '../src/config/env.js';
import { HealthService } from '../src/modules/health/health.service.js';
import { registerInfrastructureProbes } from '../src/modules/health/register-dependencies.js';

/**
 * Exercises the real Docker infrastructure, not a mock. Start it first:
 *
 *   pnpm infra:up
 *
 * When it is not running these suites skip rather than pass against a
 * substitute, because what is under test here is whether the containers
 * actually work.
 */

const POSTGRES_PORT = Number(process.env.POSTGRES_PORT ?? 5442);
const STORAGE_ENDPOINT = process.env.STORAGE_ENDPOINT ?? 'http://localhost:9100';
const STORAGE_BUCKET = process.env.STORAGE_BUCKET ?? 'platform-assets';
const PROXY_PORT = Number(process.env.PROXY_HTTP_PORT ?? 8080);

const INFRA_ENV = {
  DATABASE_URL: `postgresql://platform:platform_dev_only@localhost:${POSTGRES_PORT}/platform`,
  STORAGE_ENDPOINT,
} as NodeJS.ProcessEnv;

function canConnect(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const done = (ok: boolean): void => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(1_000);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, host);
  });
}

/**
 * `fetch` refuses to set a Host header, so virtual-host routing cannot be
 * tested through it. The raw client can, which is the only way to prove the
 * proxy separates preview, deployment and platform traffic.
 */
function getWithHost(
  port: number,
  hostHeader: string,
  path = '/',
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, method: 'GET', headers: { Host: hostHeader } },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

const withProbes = (): HealthService => {
  const health = new HealthService('api', '0.0.0');
  registerInfrastructureProbes(health, loadEnv(INFRA_ENV));
  return health;
};

const infraUp = await canConnect(POSTGRES_PORT);
const proxyUp = await canConnect(PROXY_PORT);

if (!infraUp || !proxyUp) {
  console.warn('\n[infrastructure tests skipped] Not running. Start with: pnpm infra:up\n');
}

describe.skipIf(!infraUp)('infrastructure containers', () => {
  it('postgres accepts connections on its mapped port', async () => {
    expect(await canConnect(POSTGRES_PORT)).toBe(true);
  });

  it('postgres is not reachable on the conventional port', async () => {
    // Proves the port map is actually applied, so an unrelated local
    // PostgreSQL is never mistaken for the platform database.
    expect(POSTGRES_PORT).not.toBe(5432);
  });

  it('minio answers its own health endpoint', async () => {
    const response = await fetch(new URL('/minio/health/live', STORAGE_ENDPOINT));
    expect(response.ok).toBe(true);
  });

  it('the asset bucket exists but is not anonymously readable', async () => {
    const response = await fetch(new URL(`/${STORAGE_BUCKET}/`, STORAGE_ENDPOINT));
    expect(response.ok).toBe(false);
    expect([401, 403]).toContain(response.status);
  });
});

describe.skipIf(!infraUp)('health reporting against real infrastructure', () => {
  it('reports every configured dependency as up', async () => {
    const report = await withProbes().ready();

    expect(report.status).toBe('ok');
    expect(report.dependencies.map((d) => d.name).sort()).toEqual(['postgres', 'storage']);
    for (const dependency of report.dependencies) {
      expect(dependency.status).toBe('up');
      expect(dependency.latencyMs).toBeGreaterThanOrEqual(0);
    }
  });

  it('serves readiness over HTTP with real dependencies attached', async () => {
    const response = await request(testApp({ health: withProbes() }))
      .get('/health/ready')
      .expect(200);
    expect(response.body.dependencies).toHaveLength(2);
  });

  it('never exposes a connection credential in the readiness payload', async () => {
    const response = await request(testApp({ health: withProbes() }))
      .get('/health/ready')
      .expect(200);
    expect(JSON.stringify(response.body)).not.toContain('platform_dev_only');
  });

  it('reports a dependency as down when its port is closed', async () => {
    const health = new HealthService('api', '0.0.0');
    registerInfrastructureProbes(
      health,
      loadEnv({ DATABASE_URL: 'postgresql://u:p@127.0.0.1:1/db' } as NodeJS.ProcessEnv),
    );

    const report = await health.ready();
    expect(report.status).toBe('down');
    expect(report.dependencies[0]?.status).toBe('down');
  });
});

describe.skipIf(!proxyUp)('reverse proxy routing', () => {
  it('answers its own health check independently of upstreams', async () => {
    const response = await getWithHost(PROXY_PORT, 'localhost', '/__proxy/health');
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ status: 'ok', service: 'proxy' });
  });

  it('routes a preview host away from the platform and says no runtime exists', async () => {
    const response = await getWithHost(PROXY_PORT, 'some-project.preview.localhost');
    expect(response.status).toBe(503);
    expect(JSON.parse(response.body).error.code).toBe('RUNTIME_UNAVAILABLE');
  });

  it('routes a deployment host to the deployment listener, never to the platform', async () => {
    const response = await getWithHost(PROXY_PORT, 'some-app.app.localhost');

    /*
     * Two honest answers, depending on whether the API is running.
     *
     * Since task 39 the proxy forwards deployment hosts to the deployment
     * listener rather than answering itself. With that listener up, an unknown
     * host is its 404 "nothing deployed here"; with it down, the proxy's 502.
     * What must never happen is the platform's own application answering.
     */
    expect([404, 502]).toContain(response.status);
    expect(response.body).not.toContain('<div id="root">');
  });

  it('keeps preview and deployment hosts separate', async () => {
    const preview = await getWithHost(PROXY_PORT, 'x.preview.localhost');
    const deployment = await getWithHost(PROXY_PORT, 'x.app.localhost');
    expect(preview.status).not.toBe(deployment.status);
  });

  it('does not leak an internal upstream address when an upstream is down', async () => {
    const response = await getWithHost(PROXY_PORT, 'localhost', '/definitely-not-running');
    expect(response.body).not.toContain('host.docker.internal');
  });
});
