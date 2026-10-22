import { describe, expect, it } from 'vitest';
import type { JobRecord } from './job.repository.js';
import { toSummary } from './job.service.js';

const record = (overrides: Partial<JobRecord>): JobRecord => ({
  id: 'j-1',
  projectId: 'p-1',
  type: 'DEPLOYMENT_BUILD',
  status: 'QUEUED',
  payload: { deploymentId: 'd-1', actorId: 'u-1' },
  attempts: 0,
  maxAttempts: 3,
  lastError: null,
  scheduledAt: new Date('2026-10-01T10:00:00Z'),
  startedAt: null,
  finishedAt: null,
  createdAt: new Date('2026-10-01T10:00:00Z'),
  ...overrides,
});

describe('toSummary', () => {
  it('names the deployment a build job is for', () => {
    expect(toSummary(record({})).deploymentId).toBe('d-1');
  });

  it('names no deployment for other kinds of work', () => {
    const start = record({ type: 'RUNTIME_START', payload: { runtimeId: 'r-1', actorId: 'u-1' } });
    expect(toSummary(start).deploymentId).toBeNull();
  });

  it('names none rather than guessing when the payload is not what it should be', () => {
    expect(toSummary(record({ payload: { something: 'else' } })).deploymentId).toBeNull();
  });

  it('does not expose the payload itself', () => {
    expect(toSummary(record({}))).not.toHaveProperty('payload');
  });
});
