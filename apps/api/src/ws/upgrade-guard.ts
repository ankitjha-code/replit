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

export interface UpgradeGrant {
  ok: true;
  release: () => void;
  userId: string;
  projectId: string;
  username: string;
  displayName: string | null;
  role: ProjectRole;
}

export interface UpgradeRefusal {
  ok: false;
  status: 400 | 401 | 403 | 404 | 429;
  message: string;
}

export type UpgradeDecision = UpgradeGrant | UpgradeRefusal;

export interface UpgradeGuardDependencies {
  sessions: SessionService;
  authorization: AuthorizationService;
  cookie: SessionCookieSettings;
  allowedOrigins: readonly string[];
  guard: SocketGuard;
}

export interface UpgradeRequest {
  url: string | undefined;
  headers: {
    origin?: string | undefined;
    cookie?: string | undefined;
  };
  address: string | undefined;
  permission: ProjectPermission;
  projectIdFrom: (pathname: string) => string | undefined;
}

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
    access = await deps.authorization.authorize(context.user.id, projectId, req.permission);
  } catch (error) {
    const status = error instanceof AppError && error.status === 403 ? 403 : 404;
    return { ok: false, status, message: status === 403 ? 'Forbidden' : 'Not found' };
  }

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

function pathOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url, 'http://placeholder.invalid').pathname;
  } catch {
    return undefined;
  }
}
