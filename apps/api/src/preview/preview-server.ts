import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { Duplex } from 'node:stream';
import { parseCookie } from 'cookie';
import {
  PREVIEW_SHARE_PARAM,
  PREVIEW_GRANT_PARAM,
  PREVIEW_GRANT_PATH,
  projectIdFromPreviewHost,
} from '@platform/shared';
import type { Logger } from 'pino';
import type { PreviewService, PreviewTarget } from '../modules/preview/preview.service.js';

export interface PreviewServerOptions {
  previews: PreviewService;
  log: Logger;
  hostSuffix: string;
  cookieName: string;
  cookieSecure: boolean;
  sessionTtlSeconds: number;
  workspaceUrl: string;
}

export interface PreviewServer {
  readonly server: Server;
  listen(port: number, host: string): Promise<void>;
  close(): Promise<void>;
}

export function createPreviewServer(options: PreviewServerOptions): PreviewServer {
  const server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      options.log.error({ err: error }, 'preview request failed');
      page(res, 500, 'Something went wrong', 'The preview could not be loaded.');
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const projectId = projectFromRequest(req, options.hostSuffix);
    if (!projectId) {
      page(
        res,
        404,
        'No preview here',
        'This address does not name a project. Open a preview from the workspace.',
      );
      return;
    }

    const url = new URL(req.url ?? '/', 'http://preview.invalid');

    if (url.pathname === PREVIEW_GRANT_PATH) {
      await redeem(req, res, projectId, url);
      return;
    }

    const shareToken = url.searchParams.get(PREVIEW_SHARE_PARAM);
    if (shareToken) {
      await redeemShare(res, projectId, shareToken, url);
      return;
    }

    const viewer = await currentViewer(req, projectId);
    if (!viewer) {
      page(
        res,
        401,
        'Not signed in for this preview',
        `Open this project's preview from the workspace at ${options.workspaceUrl}.`,
      );
      return;
    }

    const target = await options.previews.target(projectId);
    if (!target) {
      page(
        res,
        502,
        'Nothing is listening',
        'The project is not serving anything on the ports the platform watches. Start a server in the terminal.',
      );
      return;
    }

    forward(req, res, target, options.log);
  }

  async function redeem(
    req: IncomingMessage,
    res: ServerResponse,
    projectId: string,
    url: URL,
  ): Promise<void> {
    const token = url.searchParams.get(PREVIEW_GRANT_PARAM);
    const granted = token ? await options.previews.redeemGrant(token) : undefined;

    if (!granted || granted.projectId !== projectId) {
      page(
        res,
        403,
        'That preview link cannot be used',
        'It was already used, or it has expired. Open the preview again from the workspace.',
      );
      return;
    }

    const viewing = await options.previews.issueGrant(
      granted.projectId,
      granted.userId,
      options.sessionTtlSeconds,
    );

    res.writeHead(302, {
      location: safeReturnPath(url.searchParams.get('to')),
      'set-cookie': cookie(options, viewing.token),
      'referrer-policy': 'no-referrer',
    });
    res.end();
  }

  async function redeemShare(
    res: ServerResponse,
    projectId: string,
    token: string,
    url: URL,
  ): Promise<void> {
    const redeemed = await options.previews.redeemShare(token, options.sessionTtlSeconds);

    if (!redeemed || redeemed.projectId !== projectId) {
      page(
        res,
        403,
        'That link has stopped working',
        'It has expired, or whoever shared it turned it off.',
      );
      return;
    }

    url.searchParams.delete(PREVIEW_SHARE_PARAM);
    res.writeHead(302, {
      location: safeReturnPath(`${url.pathname}${url.search}`),
      'set-cookie': cookie(options, redeemed.viewingToken),
      'referrer-policy': 'no-referrer',
    });
    res.end();
  }

  async function currentViewer(
    req: IncomingMessage,
    projectId: string,
  ): Promise<{ userId: string | null } | undefined> {
    const token = parseCookie(req.headers.cookie ?? '')[options.cookieName];
    if (!token) return undefined;

    const grant = await options.previews.resolveViewing(token);
    if (!grant || grant.projectId !== projectId) return undefined;
    return { userId: grant.userId };
  }

  server.on('upgrade', (req, socket, head) => {
    void upgrade(req, socket, head).catch(() => socket.destroy());
  });

  async function upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const projectId = projectFromRequest(req, options.hostSuffix);
    if (!projectId || !(await currentViewer(req, projectId))) {
      socket.destroy();
      return;
    }

    const target = await options.previews.target(projectId);
    if (!target) {
      socket.destroy();
      return;
    }

    const upstream = httpRequest({
      host: target.host,
      port: target.port,
      method: req.method ?? 'GET',
      path: req.url ?? '/',
      headers: forwardedHeaders(req, target),
    });

    upstream.on('upgrade', (upstreamRes, upstreamSocket, upstreamHead) => {
      socket.write(rawStatusLine(upstreamRes));
      if (upstreamHead.length > 0) upstreamSocket.unshift(upstreamHead);
      upstreamSocket.pipe(socket).pipe(upstreamSocket);
    });

    upstream.on('error', () => socket.destroy());
    if (head.length > 0) upstream.write(head);
    req.pipe(upstream);
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

function projectFromRequest(req: IncomingMessage, suffix: string): string | undefined {
  const host = req.headers.host;
  return host ? projectIdFromPreviewHost(host, suffix) : undefined;
}

function forward(
  req: IncomingMessage,
  res: ServerResponse,
  target: PreviewTarget,
  log: Logger,
): void {
  const upstream = httpRequest(
    {
      host: target.host,
      port: target.port,
      method: req.method ?? 'GET',
      path: req.url ?? '/',
      headers: forwardedHeaders(req, target),
    },
    (upstreamRes) => {
      const headers = { ...upstreamRes.headers };
      delete headers['set-cookie'];
      delete headers['x-frame-options'];

      res.writeHead(upstreamRes.statusCode ?? 502, headers);
      upstreamRes.pipe(res);
    },
  );

  upstream.on('error', (error) => {
    log.warn({ err: error, containerPort: target.containerPort }, 'preview upstream failed');
    if (!res.headersSent) {
      page(
        res,
        502,
        'The application stopped answering',
        'It was listening a moment ago. Check the terminal for what it printed.',
      );
    } else {
      res.destroy();
    }
  });

  req.pipe(upstream);
}

function forwardedHeaders(req: IncomingMessage, target: PreviewTarget): Record<string, string> {
  const headers: Record<string, string> = {};

  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    const lower = name.toLowerCase();
    if (lower === 'cookie' || lower === 'host' || lower === 'connection') continue;
    headers[lower] = Array.isArray(value) ? value.join(', ') : value;
  }

  headers.host = `localhost:${target.containerPort}`;
  return headers;
}

function rawStatusLine(res: IncomingMessage): string {
  const lines = [`HTTP/1.1 ${res.statusCode ?? 101} ${res.statusMessage ?? 'Switching Protocols'}`];
  for (const [name, value] of Object.entries(res.headers)) {
    if (value === undefined) continue;
    for (const single of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${single}`);
  }
  return `${lines.join('\r\n')}\r\n\r\n`;
}

function cookie(options: PreviewServerOptions, token: string): string {
  const parts = [
    `${options.cookieName}=${token}`,
    'Path=/',
    'HttpOnly',
    `Max-Age=${options.sessionTtlSeconds}`,
  ];

  if (options.cookieSecure) parts.push('SameSite=None', 'Secure');
  else parts.push('SameSite=Lax');
  return parts.join('; ');
}

function page(res: ServerResponse, status: number, title: string, detail: string): void {
  const body = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  body { margin:0; display:grid; place-items:center; min-height:100vh;
         background:#0b0d10; color:#d5d9df;
         font:14px/1.5 ui-sans-serif, system-ui, sans-serif; }
  main { max-width:34rem; padding:2rem; text-align:center; }
  h1 { margin:0 0 .5rem; font-size:1.1rem; }
  p { margin:0; color:#98a1ad; }
</style></head>
<body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p></main></body></html>`;

  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
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

export function safeReturnPath(requested: string | null): string {
  if (!requested) return '/';
  if (!requested.startsWith('/') || requested.startsWith('//') || requested.startsWith('/\\')) {
    return '/';
  }
  return requested;
}
