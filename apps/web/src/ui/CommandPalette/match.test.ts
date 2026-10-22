import { describe, expect, it } from 'vitest';
import { matchScore, rank } from './match.js';

describe('matchScore', () => {
  it('matches case-insensitive subsequences and rejects the rest', () => {
    expect(matchScore('sf', 'Sync files')).not.toBeNull();
    expect(matchScore('SYNC', 'Sync files')).not.toBeNull();
    expect(matchScore('xyz', 'Sync files')).toBeNull();
    expect(matchScore('', 'anything')).toBe(0);
  });

  it('ranks a prefix above a scattered match, and word starts above the middle of words', () => {
    const items = ['Settings: Deploy', 'Sync files', 'Stop app', 'Run app'];
    const ordered = rank(items, 's', (item) => item).map((entry) => entry.item);
    expect(ordered.slice(0, 3)).toEqual(
      expect.arrayContaining(['Settings: Deploy', 'Sync files', 'Stop app']),
    );
    expect(ordered).not.toContain('Run app');
    expect(rank(items, 'sf', (item) => item)[0]?.item).toBe('Sync files');
  });
});
