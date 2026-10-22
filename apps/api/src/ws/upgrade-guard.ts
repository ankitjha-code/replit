import { parseCookie } from 'cookie';
import {
  projectIdFromDocumentPath,
  projectIdFromEventsPath,
  projectIdFromTerminalPath,
  type ProjectPermission,
  type ProjectRole,
} from '@platform/shared';
import type { SessionCookieSettings } from '../http/session-cookie.js';
import type { SessionService } from '../modules/auth/session.service.js';
import type { AuthorizationService } from '../modules/projects/authorization.service.js';
import { AppError } from '../errors/app-error.js';
import type { SocketGuard } from './socket-guard.js';

/**
 * Whether a WebSocket upgrade may be accepted.
 *
 * Decided before the socket is accepted, never after the first message. A
 * connection that is authorized once it is already open is a connection that
 * existed while unauthorized, and the window is exactly long enough to matter.
 *
 * Kept apart from the socket handling so the decisions can be tested as
 * decisions, without a server, a browser or a container.
 */

export interface UpgradeGrant {
  ok: true;
  /**
   * Gives back the socket slot this grant took.
   *
   * Returned rather than left to the caller to work out, because a gateway that
   * has to remember a key in order to release one is a gateway that will
   * eventually forget — and a leaked slot is somebody who cannot open a terminal
   * again until the process restarts. Idempotent: a socket ends in more than one
   * way.
   */
  release: () => void;
  userId: string;
  projectId: string;
  /**
   * Who the caller is, as the session says.
   *
   * Carried because presence has to show a person rather than an identifier, and
   * the session was already resolved here: making the gateway look the account
   * up again would be a second query for something this function just read.
   * Never taken from anything the client sent.
   */
  username: string;
  displayName: string | null;
  /**
   * The caller's role on this project.
   *
   * Carried because a socket sometimes has to decide more than whether to
   * accept the connection: a shared document is opened by anybody who may read
   * the project and typed into only by somebody who may write it, which is one
   * connection with two answers. Resolved here, once, from the same membership
   * row every HTTP route reads.
   */
  role: ProjectRole;
}

export interface UpgradeRefusal {
  ok: false;
  status: 400 | 401 | 403 | 404 | 429;
  /** Sent as the HTTP reason before the socket is closed. Deliberately terse. */
  message: string;
}

export type UpgradeDecision = UpgradeGrant | UpgradeRefusal;

export interface UpgradeGuardDependencies {
  sessions: SessionService;
  authorization: AuthorizationService;
  cookie: SessionCookieSettings;
  allowedOrigins: readonly string[];
  /**
   * Limits that span every gateway: sockets per account, attempts per client.
   *
   * Here rather than in each gateway because the point of both is that they
   * cross gateway boundaries. A person under every per-project ceiling can still
   * be holding eighty connections.
   */
  guard: SocketGuard;
}

export interface UpgradeRequest {
  url: string | undefined;
  headers: {
    origin?: string | undefined;
    cookie?: string | undefined;
  };
  /**
   * Where the attempt came from.
   *
   * Used only for the attempt rate, which is checked before a session is
   * resolved — at that point there is no account to charge it to, and the cost
   * being bounded is the two queries that would resolve one.
   */
  address: string | undefined;
  /** What the caller must be allowed to do on the project. */
  permission: ProjectPermission;
  /** How to read a project identifier out of this socket's own path. */
  projectIdFrom: (pathname: string) => string | undefined;
}

/**
 * The terminal's own upgrade check.
 *
 * A thin wrapper so the route and the capability it needs are named in one
 * place rather than at each call site.
 */
export function authorizeTerminalUpgrade(
  deps: UpgradeGuardDependencies,
  req: Omit<UpgradeRequest, 'permission' | 'projectIdFrom'>,
): Promise<UpgradeDecision> {
  return authorizeUpgrade(deps, {
    ...req,
    permission: 'terminal:attach',
    projectIdFrom: projectIdFromTerminalPath,
  });
}

/**
 * The event stream's own upgrade check.
 *
 * Needs only `project:read`: being told what is happening in a project is part
 * of being shown it, and a viewer who can see the files can see that they
 * changed. Nothing on that socket can change anything.
 */
export function authorizeProjectEventsUpgrade(
  deps: UpgradeGuardDependencies,
  req: Omit<UpgradeRequest, 'permission' | 'projectIdFrom'>,
): Promise<UpgradeDecision> {
  return authorizeUpgrade(deps, {
    ...req,
    permission: 'project:read',
    projectIdFrom: projectIdFromEventsPath,
  });
}

/**
 * A shared document's own upgrade check.
 *
 * Needs `file:read`, not `file:write`. Somebody who may see a project's files
 * may watch one being edited; whether they may type into it is a second
 * question, answered from the role on the grant rather than by refusing the
 * connection. A viewer shown an editor that silently discards their keystrokes
 * would be worse served than one shown a read-only editor.
 */
export function authorizeDocumentUpgrade(
  deps: UpgradeGuardDependencies,
  req: Omit<UpgradeRequest, 'permission' | 'projectIdFrom'>,
): Promise<UpgradeDecision> {
  return authorizeUpgrade(deps, {
    ...req,
    permission: 'file:read',
    projectIdFrom: projectIdFromDocumentPath,
  });
}

export async function authorizeUpgrade(
  deps: UpgradeGuardDependencies,
  req: UpgradeRequest,
): Promise<UpgradeDecision> {
  /*
   * The origin is required here, unlike on HTTP requests.
   *
   * An upgrade is a GET, so the HTTP origin check never sees it, and a
   * WebSocket is not covered by the cookie's SameSite attribute in the way a
   * fetch is. That leaves this check as the only thing standing between a
   * hostile page and a shell inside someone's project, so a missing origin is
   * refused rather than waved through. Non-browser clients can send one.
   */
  /*
   * How fast this client is trying, before anything expensive happens.
   *
   * First, because everything below it costs a database query: resolving a
   * session and authorizing a project. A client whose reconnect loop has gone
   * wrong would otherwise make the platform pay both on every attempt, with
   * nothing bounding the rate.
   */
  if (!deps.guard.mayAttempt(req.address ?? 'unknown')) {
    return { ok: false, status: 429, message: 'Too many attempts' };
  }

  const origin = req.headers.origin;
  if (!origin || !deps.allowedOrigins.includes(origin)) {
    return { ok: false, status: 403, message: 'Origin not allowed' };
  }

  const pathname = pathOf(req.url);
  const projectId = pathname === undefined ? undefined : req.projectIdFrom(pathname);
  if (!projectId) return { ok: false, status: 404, message: 'Not found' };

  const token = parseCookie(req.headers.cookie ?? '')[deps.cookie.name];
  const context = await deps.sessions.resolve(token);
  if (!context) return { ok: false, status: 401, message: 'Authentication required' };

  let access;
  try {
    // The same capability check every HTTP route uses, so a socket cannot
    // become a way around project permissions.
    access = await deps.authorization.authorize(context.user.id, projectId, req.permission);
  } catch (error) {
    // The service already answers "not found" for a project the caller may not
    // see, which is what keeps probing from revealing which projects exist.
    const status = error instanceof AppError && error.status === 403 ? 403 : 404;
    return { ok: false, status, message: status === 403 ? 'Forbidden' : 'Not found' };
  }

  /*
   * A slot, after the caller is known and allowed.
   *
   * Last, because until here there is no account to charge it to, and taking a
   * slot for somebody who turns out not to be allowed would let a refused client
   * exhaust a real person's budget.
   */
  const slot = deps.guard.acquire(context.user.id);
  if (!slot.ok) return { ok: false, status: 429, message: 'Too many open connections' };

  return {
    ok: true,
    release: slot.release,
    userId: context.user.id,
    projectId,
    username: context.user.username,
    displayName: context.user.displayName,
    role: access.role,
  };
}

/** The path, ignoring any query string, or undefined if the URL is unusable. */
function pathOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    // The base is never used; it only makes a relative URL parseable.
    return new URL(url, 'http://placeholder.invalid').pathname;
  } catch {
    return undefined;
  }
}
