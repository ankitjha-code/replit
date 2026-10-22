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
