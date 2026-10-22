import { describe, expect, it } from 'vitest';
import { executionProbe } from './execution-probe.js';
import { UnavailableExecutionProvider } from './unavailable-provider.js';
import type { ExecutionProvider } from './provider.js';

/**
 * What readiness says about the execution backend.
 *
 * The probe exists so an operator learns from `/health/ready` that containers
 * cannot be started, rather than from a user reporting that Run does nothing.
 */

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
    // The provider's reason is already written to be shown and carries no
    // internal detail, so it is passed through rather than replaced with
    // something vaguer.
    expect(result.detail).toBe('The container service is unreachable');
  });

  it('reports down for the provider that refuses everything', async () => {
    const result = await executionProbe(new UnavailableExecutionProvider()).check();
    expect(result.status).toBe('down');
  });
});
