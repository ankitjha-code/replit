import { describe, expect, it } from 'vitest';
import { parseDotenv } from './dotenv.js';

describe('reading a .env file', () => {
  it('reads plain lines, export lines and blank and comment lines', () => {
    const { entries, problems } = parseDotenv(
      ['# a comment', '', 'PORT=3000', 'export NODE_ENV=production'].join('\n'),
    );
    expect(entries.map((e) => [e.key, e.value])).toEqual([
      ['PORT', '3000'],
      ['NODE_ENV', 'production'],
    ]);
    expect(problems).toEqual([]);
  });

  it('keeps a # that is part of a value, and drops a trailing comment', () => {
    const { entries } = parseDotenv('URL=http://x/#fragment\nCOLOR=#fff\nMODE=fast # the default');
    expect(entries.map((e) => e.value)).toEqual(['http://x/#fragment', '#fff', 'fast']);
  });

  it('understands double quotes with escapes, and single quotes literally', () => {
    const { entries } = parseDotenv(
      ['GREETING="hello\\nworld"', 'QUOTED="say \\"hi\\""', "RAW='a\\nb'"].join('\n'),
    );
    expect(entries.map((e) => e.value)).toEqual(['hello\nworld', 'say "hi"', 'a\\nb']);
  });

  it('does not expand references, which would depend on reading order', () => {
    expect(parseDotenv('A=${B}').entries[0]?.value).toBe('${B}');
  });

  it('lets a later line win, and says so', () => {
    const { entries, problems } = parseDotenv('A=1\nA=2');
    expect(entries).toEqual([{ key: 'A', value: '2', line: 2 }]);
    expect(problems[0]?.line).toBe(2);
  });

  it('points at the line that is wrong', () => {
    const { problems } = parseDotenv('GOOD=1\nthis is not a line\nBAD="never closed');
    expect(problems.map((p) => p.line)).toEqual([2, 3]);
  });

  it('reads Windows line endings', () => {
    expect(parseDotenv('A=1\r\nB=2\r\n').entries.map((e) => e.value)).toEqual(['1', '2']);
  });
});
