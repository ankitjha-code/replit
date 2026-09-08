import { describe, expect, it } from 'vitest';
import { AppError } from './app-error.js';
import { normalizeError } from './normalize.js';

describe('normalizeError', () => {
  it('passes an AppError through untouched', () => {
    const original = new AppError('FORBIDDEN', 'no');
    expect(normalizeError(original)).toBe(original);
  });

  it('maps a body-parser size error to PAYLOAD_TOO_LARGE', () => {
    const raw = Object.assign(new Error('request entity too large'), {
      status: 413,
      type: 'entity.too.large',
      expose: true,
    });
    const normalized = normalizeError(raw);
    expect(normalized.code).toBe('PAYLOAD_TOO_LARGE');
    expect(normalized.status).toBe(413);
    expect(normalized.expose).toBe(true);
  });

  it('reads statusCode when status is absent', () => {
    const normalized = normalizeError(Object.assign(new Error('bad'), { statusCode: 400 }));
    expect(normalized.code).toBe('BAD_REQUEST');
  });

  it('hides a 5xx framework error behind a generic message', () => {
    const normalized = normalizeError(
      Object.assign(new Error('socket path leaked'), { status: 502 }),
    );
    expect(normalized.code).toBe('INTERNAL_ERROR');
    expect(normalized.expose).toBe(false);
  });

  it('ignores a nonsense status', () => {
    expect(normalizeError(Object.assign(new Error('x'), { status: 99 })).code).toBe(
      'INTERNAL_ERROR',
    );
  });

  it('handles a thrown non-error value', () => {
    const normalized = normalizeError('something went wrong');
    expect(normalized.code).toBe('INTERNAL_ERROR');
    expect(normalized.status).toBe(500);
  });
});
