import type { CookieOptions, Response } from 'express';
import type { Env } from '../config/env.js';

/**
 * The session cookie.
 *
 * Its flags are the browser-side half of session security, so they are set in
 * one place rather than at each call site where one could be forgotten.
 */

export interface SessionCookieSettings {
  name: string;
  secure: boolean;
  maxAgeMs: number;
}

export function sessionCookieSettings(config: Env): SessionCookieSettings {
  return {
    name: config.SESSION_COOKIE_NAME,
    // Defaults on outside development. Sending a session over plain HTTP is a
    // mistake a deployment should have to spell out, not fall into.
    secure: config.SESSION_COOKIE_SECURE ?? config.NODE_ENV === 'production',
    maxAgeMs: config.SESSION_ABSOLUTE_TTL_HOURS * 60 * 60 * 1000,
  };
}

function baseOptions(settings: SessionCookieSettings): CookieOptions {
  return {
    // Script cannot read it, so a cross-site scripting bug cannot steal the
    // session outright.
    httpOnly: true,
    secure: settings.secure,
    /**
     * Lax, not Strict. Strict would drop the cookie when a user follows a link
     * into the platform from anywhere else, which reads as being silently
     * signed out. Lax still withholds it from cross-site form posts and
     * subresource requests, which is the case that matters; unsafe methods are
     * additionally origin-checked.
     */
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

/**
 * Clears the cookie.
 *
 * The flags must match those it was set with, or the browser treats it as a
 * different cookie and leaves the original in place.
 */
export function clearSessionCookie(res: Response, settings: SessionCookieSettings): void {
  res.clearCookie(settings.name, baseOptions(settings));
}

export function readSessionCookie(
  cookies: Record<string, string | undefined> | undefined,
  settings: SessionCookieSettings,
): string | undefined {
  return cookies?.[settings.name];
}
