/**
 * Where to go after signing in.
 *
 * The `next` query parameter and the router's `state.from` both name a path
 * on this site. Only a same-origin path is honoured: anything that could
 * become another origin ("//evil.example", a scheme) falls back to home, so a
 * crafted sign-in link cannot send a fresh session somewhere else.
 */
export function safeReturnPath(value: string | null | undefined): string | undefined {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) {
    return undefined;
  }
  return value;
}

export function resolveReturnTo(
  next: string | null | undefined,
  from: string | null | undefined,
): string {
  return safeReturnPath(next) ?? safeReturnPath(from) ?? '/';
}
