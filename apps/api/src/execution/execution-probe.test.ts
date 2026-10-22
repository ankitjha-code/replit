import { describe, expect, it } from 'vitest';
import { executionProbe } from './execution-probe.js';
import { UnavailableExecutionProvider } from './unavailable-provider.js';
import type { ExecutionProvider } from './provider.js';

const providerWith = (reason: string | null): ExecutionProvider =>
  ({
    name: 'docker',
    unavailableReason: () => Promise.resolve(reason),
  }) as ExecutionProvider;

describe('the execution probe', () => {
  it('is named after the backend it is probing', () => {
    expect(executionProbe(providerWith(null)).name).toBe('execution:docker');
  });

  it('reports up when the backend can be used', async () => {
    expect(await executionProbe(providerWith(null)).check()).toEqual({
      status: 'up',
      detail: 'daemon reachable',
    });
  });

  it('reports down, and says why, when it cannot', async () => {
    const result = await executionProbe(
      providerWith('The container service is unreachable'),
    ).check();

    expect(result.status).toBe('down');
    expect(result.detail).toBe('The container service is unreachable');
  });

  it('reports down for the provider that refuses everything', async () => {
    const result = await executionProbe(new UnavailableExecutionProvider()).check();
    expect(result.status).toBe('down');
  });
});
