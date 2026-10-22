import { describe, expect, it } from 'vitest';
import { AppError, STATUS_BY_CODE } from './app-error.js';

describe('AppError', () => {
  it('takes its status from the code', () => {
    expect(new AppError('NOT_FOUND', 'gone').status).toBe(404);
    expect(new AppError('RUNTIME_UNAVAILABLE', 'no backend').status).toBe(503);
  });

  it('gives every code a status', () => {
    for (const status of Object.values(STATUS_BY_CODE)) {
      expect(status).toBeGreaterThanOrEqual(400);
      expect(status).toBeLessThan(600);
    }
  });

  it('shows a client error message to the caller', () => {
    expect(new AppError('VALIDATION_FAILED', 'Provide a name').expose).toBe(true);
  });

  it('hides a server error message, which may carry internal detail', () => {
    expect(new AppError('INTERNAL_ERROR', 'ECONNREFUSED 10.0.0.4:5432').expose).toBe(false);
  });

  it('shows an unavailable message, because that is the whole point of it', () => {
    // Replacing "no execution backend is configured" with "an unexpected
    // error occurred" sends someone looking for a bug instead of at their
    // configuration.
    expect(new AppError('RUNTIME_UNAVAILABLE', 'No execution backend').expose).toBe(true);
    expect(new AppError('SERVICE_UNAVAILABLE', 'The database is unreachable').expose).toBe(true);
  });

  it('lets a caller override the decision either way', () => {
    expect(new AppError('INTERNAL_ERROR', 'safe', { expose: true }).expose).toBe(true);
    expect(new AppError('NOT_FOUND', 'secret', { expose: false }).expose).toBe(false);
  });

  it('keeps private context off the error message', () => {
    const error = new AppError('EXECUTION_FAILED', 'Could not start', {
      context: { containerId: 'abc123' },
    });

    expect(error.message).toBe('Could not start');
    expect(error.context).toEqual({ containerId: 'abc123' });
  });
});
