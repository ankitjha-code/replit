import { ApiError } from './api-client.js';

export type FieldErrors = Partial<Record<string, string>>;

interface ValidationDetails {
  fields?: { path?: unknown; message?: unknown }[];
}

interface ConflictDetails {
  field?: unknown;
}

export function retryAdvice(error: unknown): string | undefined {
  if (!(error instanceof ApiError) || error.retryAfterSeconds === undefined) return undefined;
  const minutes = Math.ceil(error.retryAfterSeconds / 60);
  return minutes <= 1 ? 'Try again in about a minute.' : `Try again in about ${minutes} minutes.`;
}

export function rateLimitMessage(error: unknown): string {
  return `Too many requests. ${retryAdvice(error) ?? 'Try again shortly.'}`;
}

export function fieldErrorsFrom(error: unknown): { fields: FieldErrors; message?: string } {
  if (!(error instanceof ApiError)) {
    return { fields: {}, message: 'Something went wrong. Please try again.' };
  }

  if (error.code === 'VALIDATION_FAILED') {
    const details = error.details as ValidationDetails | undefined;
    const fields: FieldErrors = {};

    for (const issue of details?.fields ?? []) {
      const path = typeof issue.path === 'string' ? issue.path : undefined;
      const message = typeof issue.message === 'string' ? issue.message : undefined;
      if (path && message && !(path in fields)) fields[path] = message;
    }

    return Object.keys(fields).length > 0 ? { fields } : { fields: {}, message: error.message };
  }

  if (error.code === 'CONFLICT') {
    const details = error.details as ConflictDetails | undefined;
    const field = typeof details?.field === 'string' ? details.field : undefined;
    return field ? { fields: { [field]: error.message } } : { fields: {}, message: error.message };
  }

  if (error.code === 'RATE_LIMITED') {
    return { fields: {}, message: rateLimitMessage(error) };
  }

  return { fields: {}, message: error.message };
}
