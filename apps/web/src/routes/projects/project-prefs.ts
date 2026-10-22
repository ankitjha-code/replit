import type { ProjectSummary } from '@platform/shared';
import { readStorage, writeStorage } from '../../onboarding/storage.js';

/**
 * Per-viewer preferences for the projects list: when each project was last
 * opened from this browser, and how the list is sorted. Both are conveniences,
 * so they live in localStorage and the page renders fine without them.
 */

export const OPENED_KEY = 'projects.opened.v1';
const SORT_KEY = 'projects.sort.v1';

export type ProjectSort = 'opened' | 'name' | 'created';
export type ProjectFilter = 'all' | 'mine' | 'shared';

export const SORT_OPTIONS: ReadonlyArray<{ value: ProjectSort; label: string }> = [
  { value: 'opened', label: 'Last opened' },
  { value: 'name', label: 'Name' },
  { value: 'created', label: 'Created' },
];

export type OpenedMap = Readonly<Record<string, string>>;

export function readOpened(): OpenedMap {
  const raw = readStorage(OPENED_KEY);
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return {};
    const out: Record<string, string> = {};
    for (const [id, at] of Object.entries(parsed)) {
      if (typeof at === 'string') out[id] = at;
    }
    return out;
  } catch {
    return {};
  }
}

/** Called when a project is opened from the list; the workspace may call it too. */
export function recordProjectOpened(id: string, now: Date = new Date()): void {
  const next = { ...readOpened(), [id]: now.toISOString() };
  writeStorage(OPENED_KEY, JSON.stringify(next));
}

export function readSort(): ProjectSort {
  const stored = readStorage(SORT_KEY);
  return SORT_OPTIONS.some((option) => option.value === stored)
    ? (stored as ProjectSort)
    : 'opened';
}

export function writeSort(sort: ProjectSort): void {
  writeStorage(SORT_KEY, sort);
}

function openedAt(project: ProjectSummary, opened: OpenedMap): number {
  // A project never opened from this browser sorts by its last change, so a
  // fresh account still sees its newest project first.
  return Date.parse(opened[project.id] ?? project.updatedAt);
}

export function sortProjects(
  projects: readonly ProjectSummary[],
  sort: ProjectSort,
  opened: OpenedMap,
): ProjectSummary[] {
  const copy = [...projects];
  switch (sort) {
    case 'name':
      return copy.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    case 'created':
      return copy.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    default:
      return copy.sort((a, b) => openedAt(b, opened) - openedAt(a, opened));
  }
}

/** Name or URL contains the query (case-insensitive); role matches the chip. */
export function filterProjects(
  projects: readonly ProjectSummary[],
  query: string,
  filter: ProjectFilter,
): ProjectSummary[] {
  const needle = query.trim().toLowerCase();
  return projects.filter((project) => {
    if (filter === 'mine' && project.role !== 'OWNER') return false;
    if (filter === 'shared' && project.role === 'OWNER') return false;
    if (!needle) return true;
    return (
      project.name.toLowerCase().includes(needle) || project.slug.toLowerCase().includes(needle)
    );
  });
}
