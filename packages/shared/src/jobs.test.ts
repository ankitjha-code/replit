import { describe, expect, it } from 'vitest';
import { jobSummarySchema } from './jobs.js';

const job = {
  id: 'j-1',
  type: 'DEPLOYMENT_BUILD',
  status: 'QUEUED',
  attempts: 0,
  maxAttempts: 3,
  lastError: null,
  scheduledAt: '2026-10-01T10:00:00.000Z',
  startedAt: null,
  finishedAt: null,
  createdAt: '2026-10-01T10:00:00.000Z',
};

describe('jobSummarySchema', () => {
  it('carries the deployment a build job is for', () => {
    expect(jobSummarySchema.parse({ ...job, deploymentId: 'd-1' }).deploymentId).toBe('d-1');
  });

  it('reads a summary from a server that does not send the field yet', () => {
    // A rolling deploy can put a new page in front of an older API.
    expect(jobSummarySchema.parse(job).deploymentId).toBeNull();
  });
});
