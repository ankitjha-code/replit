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

/**
 * Deployed projects, served to the public.
 *
 * A third listener, on a third port, and the reasoning is the preview's with
 * one line changed. A preview serves a project's code to the person who owns
 * it; this serves it to anybody. On the platform's own origin it could act as
 * whoever opened it, so every project gets a hostname of its own and can reach
 * neither the platform nor another project.
 *
 * Nothing here is authenticated, and that is the feature. A deployment exists
 * to be opened by somebody with no account, so there is no cookie to check and
 * no session to resolve. What protects the platform is that this process shares
 * nothing with it but a database connection: no session cookie is readable from
 * this origin, and no request that arrives here is ever treated as coming from
 * a signed-in person.
 *
 * Two kinds of answer:
 *
 *  - **A static site** is answered from bytes the platform stored. Nothing is
 *    running, so a static deployment keeps serving while the container backend
 *    is down, being upgraded, or missing entirely.
 *  - **A server** is proxied to a loopback address the container runtime
 *    published. The container is never reachable from the network; this process
 *    is the only door.
 */

export interface DeploymentServerOptions {
  deployments: DeploymentService;
  /**
   * Turns a hostname into a project.
   *
   * Asked rather than parsed here, because a request can arrive on the
   * platform's own domain or on somebody else's, and only one of those is
   * answerable by looking at the string.
   */
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

    /*
     * A project's address serves whatever is live; a release's serves itself.
     *
     * That is the whole difference, and it is what makes it possible to look at
     * a change before pointing everybody at it, and to check that a rollback
     * actually went back rather than trusting a status.
     */
    const serving =
      'projectId' in resolved
        ? await options.deployments.serving(resolved.projectId)
        : await options.deployments.servingRelease(resolved.releaseLabel);

    if (!serving) {
      /*
       * Nothing is deployed, which is not an error.
       *
       * Said the same way whether the project has never been deployed, was
       * stopped, or does not exist. A public address that distinguished them
       * would let anybody walk identifiers and learn which projects are real.
       */
      page(res, 404, 'Nothing deployed here', 'There is no site at this address.');
      return;
    }

    if (serving.kind === 'static') {
      await serveStatic(req, res, serving);
      return;
    }

    forward(req, res, serving, options.log);
  }

  /** One file out of a stored site, or a not-found page. */
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

    /*
     * A HEAD is answered with the headers and none of the body.
     *
     * Cheap to support and routinely used by anything checking whether a site
     * is up, which is exactly what somebody does to a deployment.
     */
    res.writeHead(200, {
      'content-type': file.contentType,
      'content-length': String(file.content.byteLength),
      /*
       * Never sniffed, and never framed by the platform.
       *
       * These are bytes somebody uploaded. Letting a browser decide a text file
       * is a script because of what is inside it is how a static host becomes a
       * way to run code on its own origin.
       */
      'x-content-type-options': 'nosniff',
      /*
       * Not cached by anything in between.
       *
       * A deployment's address is stable and its content changes underneath it
       * on the next deploy. Until the platform can put a version in the URL,
       * saying "do not keep this" is the only way a redeploy is visible.
       */
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

/**
 * Forwards one request to a server deployment and streams the answer back.
 *
 * The headers that are dropped matter more than they look. A cookie is never
 * forwarded, because a deployment is code the platform did not write and a
 * session token is not something to hand it — and on this origin there should
 * be no platform cookie to forward in the first place, so this is the second
 * line rather than the first.
 *
 * Unlike a preview, `Set-Cookie` **is** passed back. A deployed application is
 * allowed its own sessions on its own origin: there is no viewing grant here to
 * be overwritten, which was the only reason the preview strips it.
 */
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
    // Hop-by-hop headers describe this connection rather than the request, and
    // the platform's cookies are never handed to somebody else's code.
    if (lower === 'cookie' || lower === 'host' || lower === 'connection') continue;
    headers[lower] = Array.isArray(value) ? value.join(', ') : value;
  }

  headers['x-forwarded-proto'] = 'http';
  return headers;
}

/** The path part of a request, with the query removed. */
function pathOf(url: string | undefined): string {
  const raw = url ?? '/';
  const query = raw.indexOf('?');
  const path = query === -1 ? raw : raw.slice(0, query);

  try {
    return decodeURIComponent(path);
  } catch {
    // A malformed escape is not a path. Returning it undecoded means it simply
    // matches nothing, which is the right outcome.
    return path;
  }
}

/**
 * A plain page, for the platform's own answers.
 *
 * Deliberately austere and deliberately not branded: this is served on a
 * project's hostname, and a page that looked like the platform would be a page
 * a project could imitate.
 */
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
