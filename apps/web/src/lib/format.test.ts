import { describe, expect, it } from 'vitest';
import {
  describeCounts,
  formatBytes,
  formatCount,
  formatDateTime,
  formatDuration,
  relativeTime,
} from './format.js';

describe('formatBytes', () => {
  it('uses one unit table with kB and MB', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1024)).toBe('1.0 kB');
    expect(formatBytes(15 * 1024)).toBe('15 kB');
    expect(formatBytes(2.5 * 1024 * 1024)).toBe('2.5 MB');
    expect(formatBytes(3 * 1024 ** 3)).toBe('3.0 GB');
    expect(formatBytes(5000 * 1024 ** 4)).toBe('5000 TB');
  });

  it('never prints a negative or non-finite size', () => {
    expect(formatBytes(-5)).toBe('0 B');
    expect(formatBytes(Number.NaN)).toBe('0 B');
  });
});

describe('formatCount', () => {
  it('pluralises by count', () => {
    expect(formatCount(1, 'file')).toBe('1 file');
    expect(formatCount(0, 'file')).toBe('0 files');
    expect(formatCount(2, 'entry', 'entries')).toBe('2 entries');
  });
});

describe('describeCounts', () => {
  it('lists only the non-zero changes', () => {
    expect(describeCounts({ created: 2, updated: 0, deleted: 1 })).toBe('2 added, 1 removed');
  });

  it('says so when nothing changed', () => {
    expect(describeCounts({ created: 0, updated: 0, deleted: 0 })).toBe('nothing changed');
  });
});

describe('formatDuration', () => {
  it('shows the two largest units', () => {
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(12)).toBe('12s');
    expect(formatDuration(65)).toBe('1m 5s');
    expect(formatDuration(3_600 + 300)).toBe('1h 5m');
    expect(formatDuration(86_400 + 2 * 3_600 + 59)).toBe('1d 2h');
  });

  it('skips a zero middle unit', () => {
    expect(formatDuration(86_400 + 300)).toBe('1d 5m');
  });
});

describe('formatDateTime', () => {
  it('includes the zone and says when a value is not a date', () => {
    expect(formatDateTime('2026-09-30T10:15:00Z')).toMatch(/2026/);
    expect(formatDateTime('2026-09-30T10:15:00Z')).toMatch(/GMT|UTC|[A-Z]{2,5}/);
    expect(formatDateTime('not a date')).toBe('Unknown time');
  });
});

describe('relativeTime', () => {
  const now = Date.parse('2026-09-30T12:00:00Z');

  it('rounds to the nearest sensible unit', () => {
    expect(relativeTime(now - 10_000, now)).toBe('just now');
    expect(relativeTime(now - 3 * 60_000, now)).toBe('3 min ago');
    expect(relativeTime(now - 60_000, now)).toBe('1 min ago');
    expect(relativeTime(now - 2 * 3_600_000, now)).toBe('2 hours ago');
    expect(relativeTime(now - 3_600_000, now)).toBe('1 hour ago');
    expect(relativeTime(now - 3 * 86_400_000, now)).toBe('3 days ago');
  });

  it('handles the future and far past', () => {
    expect(relativeTime(now + 5 * 60_000, now)).toBe('in 5 min');
    expect(relativeTime(now - 60 * 86_400_000, now)).toMatch(/Aug|Jul/);
    expect(relativeTime('nope', now)).toBe('Unknown time');
  });
});
