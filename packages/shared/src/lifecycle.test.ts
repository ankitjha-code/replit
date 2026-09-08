import { describe, expect, it } from 'vitest';
import {
  DEPLOYMENT_STATUSES,
  DEPLOYMENT_TRANSITIONS,
  RUNTIME_STATUSES,
  RUNTIME_TRANSITIONS,
  canTransition,
  isTerminal,
} from './lifecycle.js';

describe('runtime lifecycle', () => {
  it('declares a transition list for every status', () => {
    for (const status of RUNTIME_STATUSES) {
      expect(RUNTIME_TRANSITIONS[status]).toBeDefined();
    }
  });

  it('only names known statuses as targets', () => {
    for (const targets of Object.values(RUNTIME_TRANSITIONS)) {
      for (const target of targets) {
        expect(RUNTIME_STATUSES).toContain(target);
      }
    }
  });

  it('walks the happy path from request to running', () => {
    expect(canTransition(RUNTIME_TRANSITIONS, 'REQUESTED', 'CREATING')).toBe(true);
    expect(canTransition(RUNTIME_TRANSITIONS, 'CREATING', 'STARTING')).toBe(true);
    expect(canTransition(RUNTIME_TRANSITIONS, 'STARTING', 'RUNNING')).toBe(true);
  });

  it('rejects skipping states', () => {
    expect(canTransition(RUNTIME_TRANSITIONS, 'REQUESTED', 'RUNNING')).toBe(false);
    expect(canTransition(RUNTIME_TRANSITIONS, 'STOPPED', 'RUNNING')).toBe(false);
  });

  it('lets every non-terminal state fail', () => {
    for (const status of ['REQUESTED', 'CREATING', 'STARTING', 'RUNNING', 'STOPPING'] as const) {
      expect(canTransition(RUNTIME_TRANSITIONS, status, 'FAILED')).toBe(true);
    }
  });

  it('treats stopped and failed as terminal until re-requested', () => {
    expect(isTerminal(RUNTIME_TRANSITIONS, 'STOPPED', 'REQUESTED')).toBe(true);
    expect(isTerminal(RUNTIME_TRANSITIONS, 'FAILED', 'REQUESTED')).toBe(true);
    expect(isTerminal(RUNTIME_TRANSITIONS, 'RUNNING', 'REQUESTED')).toBe(false);
  });
});

describe('deployment lifecycle', () => {
  it('only names known statuses as targets', () => {
    for (const targets of Object.values(DEPLOYMENT_TRANSITIONS)) {
      for (const target of targets) {
        expect(DEPLOYMENT_STATUSES).toContain(target);
      }
    }
  });

  it('builds before it starts', () => {
    expect(canTransition(DEPLOYMENT_TRANSITIONS, 'REQUESTED', 'BUILDING')).toBe(true);
    expect(canTransition(DEPLOYMENT_TRANSITIONS, 'BUILDING', 'STARTING')).toBe(true);
    expect(canTransition(DEPLOYMENT_TRANSITIONS, 'REQUESTED', 'RUNNING')).toBe(false);
  });

  it('can fail during build', () => {
    expect(canTransition(DEPLOYMENT_TRANSITIONS, 'BUILDING', 'FAILED')).toBe(true);
  });
});
