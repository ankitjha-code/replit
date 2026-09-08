import { ApiError } from './api-client.js';

/**
 * Maps a server rejection onto the form fields that caused it.
 *
 * The server is the authority on validity: the browser's copy of the schema
 * exists for fast feedback, but a rejection that arrives anyway has to be
 * shown against the right input or the user cannot act on it.
 */
export type FieldErrors = Partial<Record<string, string>>;

interface ValidationDetails {
  fields?: { path?: unknown; message?: unknown }[];
}

interface ConflictDetails {
  field?: unknown;
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
      // Keep the first message per field: a list of five rules under one
      // input is noise, not help.
      if (path && message && !(path in fields)) fields[path] = message;
    }

    return Object.keys(fields).length > 0 ? { fields } : { fields: {}, message: error.message };
  }

  if (error.code === 'CONFLICT') {
    const details = error.details as ConflictDetails | undefined;
    const field = typeof details?.field === 'string' ? details.field : undefined;
    return field ? { fields: { [field]: error.message } } : { fields: {}, message: error.message };
  }

  return { fields: {}, message: error.message };
}
