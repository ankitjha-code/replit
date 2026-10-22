import { describe, expect, it } from 'vitest';
import { findMatches } from './OutputView.js';
import { exitLine } from './use-run.js';
import type { OutputLine } from './use-run.js';

const line = (data: string): OutputLine => ({ stream: 'stdout', data, at: 0 });

describe('searching the output', () => {
  it('finds every occurrence, ignoring case', () => {
    expect(findMatches([line('GET / 200\n'), line('get /x 404\n')], 'Get')).toEqual([
      { line: 0, start: 0, end: 3 },
      { line: 1, start: 0, end: 3 },
    ]);
  });

  it('looks at the text a person sees, not the colour codes around it', () => {
    expect(findMatches([line('\u001b[32mready\u001b[0m')], 'ready')).toEqual([
      { line: 0, start: 0, end: 5 },
    ]);
  });

  it('finds nothing for an empty query', () => {
    expect(findMatches([line('anything')], '')).toEqual([]);
  });
});

describe('the line a program leaves when it ends', () => {
  const ended = {
    status: 'FAILED' as const,
    command: 'node index.js',
    configuredCommand: null,
    suggestion: null,
    startedAt: '2026-01-01T00:00:00.000Z',
    exitedAt: '2026-01-01T00:01:05.000Z',
    exitCode: 1,
    message: null,
    blockedReason: null,
  };

  it('says the code and how long it ran', () => {
    expect(exitLine(ended)).toBe('Exited with code 1 after 1m 5s');
  });

  it('says only that it exited when the platform could not learn the code', () => {
    expect(exitLine({ ...ended, exitCode: null, exitedAt: null })).toBe('Exited');
  });
});
