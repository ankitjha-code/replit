import type { CookieOptions, Response } from 'express';
import type { Env } from '../config/env.js';

export interface SessionCookieSettings {
  name: string;
  secure: boolean;
  maxAgeMs: number;
}

export function sessionCookieSettings(config: Env): SessionCookieSettings {
  return {
    name: config.SESSION_COOKIE_NAME,
    secure: config.SESSION_COOKIE_SECURE ?? config.NODE_ENV === 'production',
    maxAgeMs: config.SESSION_ABSOLUTE_TTL_HOURS * 60 * 60 * 1000,
  };
}

function baseOptions(settings: SessionCookieSettings): CookieOptions {
  return {
    httpOnly: true,
    secure: settings.secure,
    sameSite: 'lax',
    path: '/',
  };
}

export function setSessionCookie(
  res: Response,
  token: string,
  settings: SessionCookieSettings,
): void {
  res.cookie(settings.name, token, { ...baseOptions(settings), maxAge: settings.maxAgeMs });
}

export function clearSessionCookie(res: Response, settings: SessionCookieSettings): void {
  res.clearCookie(settings.name, baseOptions(settings));
}

export function readSessionCookie(
  cookies: Record<string, string | undefined> | undefined,
  settings: SessionCookieSettings,
): string | undefined {
  return cookies?.[settings.name];
}
