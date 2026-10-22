import type { ProjectSummary } from '@platform/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  filterProjects,
  readOpened,
  readSort,
  recordProjectOpened,
  sortProjects,
  writeSort,
} from './project-prefs.js';

const project = (overrides: Partial<ProjectSummary>): ProjectSummary => ({
  id: 'a',
  slug: 'alpha',
  name: 'Alpha',
  description: null,
  role: 'OWNER',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

const alpha = project({});
const beta = project({
  id: 'b',
  slug: 'beta',
  name: 'beta',
  role: 'VIEWER',
  createdAt: '2026-02-01T00:00:00.000Z',
  updatedAt: '2026-02-01T00:00:00.000Z',
});
const gamma = project({
  id: 'c',
  slug: 'gamma-site',
  name: 'Gamma',
  role: 'EDITOR',
  createdAt: '2026-03-01T00:00:00.000Z',
  updatedAt: '2026-01-15T00:00:00.000Z',
});

beforeEach(() => window.localStorage.clear());

describe('project preferences', () => {
  it('sorts by name regardless of case, by creation, and by last opened with a change fallback', () => {
    expect(sortProjects([gamma, alpha, beta], 'name', {}).map((p) => p.id)).toEqual([
      'a',
      'b',
      'c',
    ]);
    expect(sortProjects([alpha, beta, gamma], 'created', {}).map((p) => p.id)).toEqual([
      'c',
      'b',
      'a',
    ]);
    // Never opened here: the most recently changed comes first.
    expect(sortProjects([alpha, beta, gamma], 'opened', {}).map((p) => p.id)).toEqual([
      'b',
      'c',
      'a',
    ]);
    // Opening Alpha just now puts it first.
    recordProjectOpened('a', new Date('2026-04-01T00:00:00.000Z'));
    expect(sortProjects([alpha, beta, gamma], 'opened', readOpened()).map((p) => p.id)).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('filters by name or URL and by whose project it is', () => {
    const all = [alpha, beta, gamma];
    expect(filterProjects(all, 'site', 'all').map((p) => p.id)).toEqual(['c']);
    expect(filterProjects(all, 'ALPHA', 'all').map((p) => p.id)).toEqual(['a']);
    expect(filterProjects(all, '', 'mine').map((p) => p.id)).toEqual(['a']);
    expect(filterProjects(all, '', 'shared').map((p) => p.id)).toEqual(['b', 'c']);
    expect(filterProjects(all, 'zzz', 'all')).toEqual([]);
  });

  it('remembers the sort and ignores a value it does not know', () => {
    expect(readSort()).toBe('opened');
    writeSort('name');
    expect(readSort()).toBe('name');
    window.localStorage.setItem('projects.sort.v1', 'bogus');
    expect(readSort()).toBe('opened');
  });

  it('survives a corrupt opened map', () => {
    window.localStorage.setItem('projects.opened.v1', '{not json');
    expect(readOpened()).toEqual({});
    window.localStorage.setItem('projects.opened.v1', JSON.stringify({ a: 1, b: 'x' }));
    expect(readOpened()).toEqual({ b: 'x' });
  });
});
