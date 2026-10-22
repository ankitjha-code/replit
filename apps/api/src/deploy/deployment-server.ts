import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { Logger } from 'pino';
import type {
  DeploymentService,
  ServingDeployment,
} from '../modules/deployments/deployment.service.js';
import type { DomainService } from '../modules/domains/domain.service.js';
import type { ArtifactStore } from './artifact-store.js';

export interface DeploymentServerOptions {
  deployments: DeploymentService;
  domains: DomainService;
  artifacts: ArtifactStore;
  log: Logger;
}

export interface DeploymentServer {
  readonly server: Server;
  listen(port: number, host: string): Promise<void>;
  close(): Promise<void>;
}

export function createDeploymentServer(options: DeploymentServerOptions): DeploymentServer {
  const server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      options.log.error({ err: error }, 'deployment request failed');
      page(res, 500, 'Something went wrong', 'This site could not be loaded.');
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const host = req.headers.host;
    const resolved = host ? await options.domains.resolve(host) : null;

    if (!resolved) {
      page(res, 404, 'Nothing here', 'This address does not name a deployed project.');
      return;
    }

    const serving =
      'projectId' in resolved
        ? await options.deployments.serving(resolved.projectId)
        : await options.deployments.servingRelease(resolved.releaseLabel);

    if (!serving) {
      page(res, 404, 'Nothing deployed here', 'There is no site at this address.');
      return;
    }

    if (serving.kind === 'static') {
      await serveStatic(req, res, serving);
      return;
    }

    forward(req, res, serving, options.log);
  }

  async function serveStatic(
    req: IncomingMessage,
    res: ServerResponse,
    serving: Extract<ServingDeployment, { kind: 'static' }>,
  ): Promise<void> {
    const path = pathOf(req.url);
    const file = await options.artifacts.file(serving.artifactKey, path);

    if (!file) {
      page(res, 404, 'Not found', 'There is no page at this address.');
      return;
    }

    res.writeHead(200, {
      'content-type': file.contentType,
      'content-length': String(file.content.byteLength),
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-cache',
    });

    if (req.method === 'HEAD') {
      res.end();
      return;
    }

    res.end(file.content);
  }

  return {
    server,
    listen: (port, host) =>
      new Promise<void>((resolve) => server.listen(port, host, () => resolve())),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function forward(
  req: IncomingMessage,
  res: ServerResponse,
  serving: Extract<ServingDeployment, { kind: 'server' }>,
  log: Logger,
): void {
  const upstream = httpRequest(
    {
      host: serving.target.host,
      port: serving.target.port,
      method: req.method ?? 'GET',
      path: req.url ?? '/',
      headers: forwardedHeaders(req),
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    },
  );

  upstream.on('error', (error) => {
    log.warn({ err: error }, 'deployment upstream failed');

    if (!res.headersSent) {
      page(
        res,
        502,
        'This site stopped answering',
        'It was running a moment ago. The deployment may have crashed.',
      );
      return;
    }
    res.destroy();
  });

  req.pipe(upstream);
}

function forwardedHeaders(req: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};

  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    const lower = name.toLowerCase();
    if (lower === 'cookie' || lower === 'host' || lower === 'connection') continue;
    headers[lower] = Array.isArray(value) ? value.join(', ') : value;
  }

  headers['x-forwarded-proto'] = 'http';
  return headers;
}

function pathOf(url: string | undefined): string {
  const raw = url ?? '/';
  const query = raw.indexOf('?');
  const path = query === -1 ? raw : raw.slice(0, query);

  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

function page(res: ServerResponse, status: number, title: string, detail: string): void {
  const body = `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title><body style="font:16px system-ui;margin:4rem auto;max-width:34rem;color:#111"><h1 style="font-size:1.3rem">${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p></body>`;

  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ??
      character,
  );
}
