import type {
  CustomDomainListResponse,
  CustomDomainSummary,
  DeploymentStateResponse,
  DeploymentSummary,
  JobSummary,
} from '@platform/shared';

/*
 * Fixtures for the Deploy group's tests, shaped exactly as the shared schemas
 * expect so the API clients' parsing is exercised rather than bypassed.
 */

export const PROJECT_ID = '018f0000-0000-7000-8000-0000000000aa';
export const SHIP_API = `/api/projects/${PROJECT_ID}`;

export const deployment = (
  id: string,
  overrides: Partial<DeploymentSummary> = {},
): DeploymentSummary => ({
  id,
  status: 'STOPPED',
  target: 'STATIC',
  note: null,
  buildCommand: 'npm run build',
  outputDirectory: 'dist',
  startCommand: null,
  snapshotId: `snap-${id}`,
  url: null,
  message: null,
  fileCount: 12,
  artifactBytes: 40_960,
  hasLog: true,
  requestedBy: 'ada',
  createdAt: '2026-01-01T10:00:00.000Z',
  statusChangedAt: '2026-01-01T10:01:00.000Z',
  startedAt: null,
  stoppedAt: null,
  releaseUrl: null,
  rolledBackFromId: null,
  ...overrides,
});

export const deploymentState = (
  overrides: Partial<DeploymentStateResponse> = {},
): DeploymentStateResponse => ({
  deployments: [],
  subdomain: null,
  url: null,
  config: null,
  suggestion: null,
  liveId: null,
  unavailableReason: null,
  limit: 10,
  ...overrides,
});

export const domain = (
  id: string,
  overrides: Partial<CustomDomainSummary> = {},
): CustomDomainSummary => ({
  id,
  hostname: `${id}.example.com`,
  status: 'PENDING',
  verificationToken: `token-${id}`,
  message: null,
  verifiedAt: null,
  lastCheckedAt: null,
  createdAt: '2026-01-01T10:00:00.000Z',
  ...overrides,
});

export const domainList = (
  overrides: Partial<CustomDomainListResponse> = {},
): CustomDomainListResponse => ({
  domains: [],
  subdomain: 'hello',
  target: 'hello.deploy.localhost:4100',
  verificationPrefix: '_platform-verify',
  unavailableReason: null,
  limit: 5,
  ...overrides,
});

export const job = (id: string, overrides: Partial<JobSummary> = {}): JobSummary => ({
  id,
  type: 'RUNTIME_START',
  status: 'QUEUED',
  attempts: 0,
  maxAttempts: 3,
  lastError: null,
  deploymentId: null,
  scheduledAt: '2026-01-01T10:00:00.000Z',
  startedAt: null,
  finishedAt: null,
  createdAt: '2026-01-01T10:00:00.000Z',
  ...overrides,
});
