import { describe, expect, it } from 'vitest';
import type { ErrorCode } from '@platform/shared';
import { ApiError } from '../../lib/api-client.js';
import { RETRY_MAX_MS, classifyFailure, retryDelay } from './save-policy.js';

const apiError = (code: ErrorCode, status = 500) => new ApiError(code, 'message', status);

describe('classifyFailure', () => {
  it('treats a lost connection as transient', () => {
    // The client turns an unreachable server into this, and it heals on its own.
    expect(classifyFailure(apiError('SERVICE_UNAVAILABLE', 0))).toBe('retry');
  });

  it('treats a server fault as transient', () => {
    expect(classifyFailure(apiError('INTERNAL_ERROR', 500))).toBe('retry');
  });

  it('treats rate limiting as transient', () => {
    // The limit lifts, and the delay grows with each attempt.
    expect(classifyFailure(apiError('RATE_LIMITED', 429))).toBe('retry');
  });

  it('treats an unrecognised failure as transient', () => {
    // Retrying costs a request; giving up could cost someone's work.
    expect(classifyFailure(new TypeError('boom'))).toBe('retry');
    expect(classifyFailure(undefined)).toBe('retry');
  });

  it('recognises a conflict, which needs a decision', () => {
    expect(classifyFailure(apiError('CONFLICT', 409))).toBe('conflict');
  });

  it('stops for failures retrying cannot fix', () => {
    for (const code of [
      'PAYLOAD_TOO_LARGE',
      'FORBIDDEN',
      'UNAUTHENTICATED',
      'VALIDATION_FAILED',
      'NOT_FOUND',
      'BAD_REQUEST',
    ] as const) {
      expect(classifyFailure(apiError(code, 400))).toBe('blocked');
    }
  });
});

describe('retryDelay', () => {
  it('grows with each attempt', () => {
    expect(retryDelay(1)).toBeLessThan(retryDelay(2));
    expect(retryDelay(2)).toBeLessThan(retryDelay(3));
  });

  it('starts within a second', () => {
    expect(retryDelay(1)).toBeLessThanOrEqual(1_000);
  });

  it('never exceeds the ceiling', () => {
    // Someone who leaves a tab open through a long outage should get their
    // work saved shortly after the server returns, not hours later.
    for (const attempt of [10, 50, 1_000]) {
      expect(retryDelay(attempt)).toBe(RETRY_MAX_MS);
    }
  });

  it('is never zero, so a failing server is not hammered', () => {
    expect(retryDelay(0)).toBeGreaterThan(0);
    expect(retryDelay(1)).toBeGreaterThan(0);
  });
});
