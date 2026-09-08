import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import type { ExecutionProvider, ProviderState } from '../execution/provider.js';
import type { DeploymentRepository } from '../modules/deployments/deployment.repository.js';
import type { JobRepository } from '../modules/jobs/job.repository.js';
import type { RuntimeRepository } from '../modules/runtimes/runtime.repository.js';
import type { UserDatabaseProvider } from '../userdb/provider.js';
import { StartupRecovery } from './recovery.js';
import type {
  RecoveryRepository,
  UnfinishedDeployment,
  UnfinishedRuntime,
} from './recovery.repository.js';

function runtime(overrides: Partial<UnfinishedRuntime> = {}): UnfinishedRuntime {
  return {
    id: 'r-1',
    projectId: 'p-1',
    status: 'RUNNING',
    revision: 1,
    externalId: 'c-1',
    runStatus: 'IDLE',
    ...overrides,
  };
}

function deployment(overrides: Partial<UnfinishedDeployment> = {}): UnfinishedDeployment {
  return {
    id: 'd-1',
    projectId: 'p-1',
    status: 'BUILDING',
    revision: 1,
    externalId: 'c-9',
    ...overrides,
  };
}

function build(
  options: {
    runtimes?: UnfinishedRuntime[];
    deployments?: UnfinishedDeployment[];
    observed?: ProviderState;
    executionDown?: boolean;
    outstandingJobs?: { id: string; type: string; payload: unknown }[];
  } = {},
) {
  const runtimeMoves: { from: string; to: string }[] = [];
  const deploymentMoves: { from: string; to: string }[] = [];
  const stopped: string[] = [];

  const recovery = {
    listUnfinishedRuntimes: () => Promise.resolve(options.runtimes ?? []),
    listUnfinishedDeployments: () => Promise.resolve(options.deployments ?? []),
    listProvisioningDatabases: () => Promise.resolve([]),
    listOutstandingJobs: () => Promise.resolve(options.outstandingJobs ?? []),
  } as unknown as RecoveryRepository;

  const runtimes = {
    transition: (input: { from: string; to: string }) => {
      runtimeMoves.push({ from: input.from, to: input.to });
      return Promise.resolve({});
    },
    setRunState: () => Promise.resolve({}),
  } as unknown as RuntimeRepository;

  const deployments = {
    transition: (input: { from: string; to: string }) => {
      deploymentMoves.push({ from: input.from, to: input.to });
      return Promise.resolve({});
    },
  } as unknown as DeploymentRepository;

  const jobs = {
    reclaimStale: () => Promise.resolve({ requeued: [], failed: [] }),
  } as unknown as JobRepository;

  const execution = {
    unavailableReason: () =>
      Promise.resolve(options.executionDown ? 'The container runtime is not reachable.' : null),
    inspect: () => Promise.resolve(options.observed ?? 'running'),
    processRunning: () => Promise.resolve(false),
    stop: (handle: { externalId: string }) => {
      stopped.push(handle.externalId);
      return Promise.resolve();
    },
  } as unknown as ExecutionProvider;

  const userDatabases = {
    unavailableReason: () => Promise.resolve(null),
    list: () => Promise.resolve([]),
  } as unknown as UserDatabaseProvider;

  const service = new StartupRecovery(
    recovery,
    runtimes,
    deployments,
    jobs,
    execution,
    userDatabases,
    { jobStaleAfterMs: 60_000, timeoutMs: 5_000 },
    pino({ level: 'silent' }),
  );

  return { service, runtimeMoves, deploymentMoves, stopped };
}

describe('never guessing', () => {
  it('changes nothing when the execution plane cannot be asked', async () => {
    // Treating "could not ask" as "not there" would fail every running project
    // on the installation the first time a socket was busy at boot.
    const { service, runtimeMoves, deploymentMoves } = build({
      executionDown: true,
      runtimes: [runtime()],
      deployments: [deployment()],
      observed: 'absent',
    });

    const report = await service.recover();

    expect(runtimeMoves).toEqual([]);
    expect(deploymentMoves).toEqual([]);
    expect(report.runtimes.skipped).toContain('not reachable');
  });
});

describe('runtimes', () => {
  it('leaves a running runtime alone when its container is running', async () => {
    const { service, runtimeMoves } = build({ runtimes: [runtime()], observed: 'running' });
    await service.recover();
    expect(runtimeMoves).toEqual([]);
  });

  it('calls a running runtime stopped when its container is gone', async () => {
    const { service, runtimeMoves } = build({ runtimes: [runtime()], observed: 'absent' });
    await service.recover();
    expect(runtimeMoves).toEqual([{ from: 'RUNNING', to: 'STOPPED' }]);
  });

  it('fails a start that was interrupted', async () => {
    const { service, runtimeMoves } = build({
      runtimes: [runtime({ status: 'STARTING' })],
      observed: 'exited',
    });
    await service.recover();
    expect(runtimeMoves).toEqual([{ from: 'STARTING', to: 'FAILED' }]);
  });

  it('walks a runtime forward through legal states when its container came up', async () => {
    // CREATING cannot jump to RUNNING. Each step is its own event, so the
    // history reads as a history.
    const { service, runtimeMoves } = build({
      runtimes: [runtime({ status: 'CREATING' })],
      observed: 'running',
    });
    await service.recover();
    expect(runtimeMoves).toEqual([
      { from: 'CREATING', to: 'STARTING' },
      { from: 'STARTING', to: 'RUNNING' },
    ]);
  });

  it('finishes a stop that was interrupted, stopping the container first', async () => {
    const { service, runtimeMoves, stopped } = build({
      runtimes: [runtime({ status: 'STOPPING' })],
      observed: 'running',
    });
    await service.recover();
    expect(stopped).toEqual(['c-1']);
    expect(runtimeMoves).toEqual([{ from: 'STOPPING', to: 'STOPPED' }]);
  });
});

describe('deployments', () => {
  it('fails a live deployment whose container is gone, rather than calling it stopped', async () => {
    // A development environment being down is ordinary. A site being down is
    // an outage, and "stopped" would hide it.
    const { service, deploymentMoves } = build({
      deployments: [deployment({ status: 'RUNNING' })],
      observed: 'absent',
    });
    await service.recover();
    expect(deploymentMoves).toEqual([{ from: 'RUNNING', to: 'FAILED' }]);
  });

  it('leaves alone a build the queue still intends to run', async () => {
    const { service, deploymentMoves } = build({
      deployments: [deployment({ status: 'BUILDING' })],
      observed: 'absent',
      outstandingJobs: [{ id: 'j-1', type: 'DEPLOYMENT_BUILD', payload: { deploymentId: 'd-1' } }],
    });
    await service.recover();
    expect(deploymentMoves).toEqual([]);
  });

  it('walks a deployment through BUILDING, not CREATING, when it came up', async () => {
    const { service, deploymentMoves } = build({
      deployments: [deployment({ status: 'REQUESTED' })],
      observed: 'running',
    });
    await service.recover();
    expect(deploymentMoves).toEqual([
      { from: 'REQUESTED', to: 'BUILDING' },
      { from: 'BUILDING', to: 'STARTING' },
      { from: 'STARTING', to: 'RUNNING' },
    ]);
  });
});
