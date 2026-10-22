import { describe, expect, it } from 'vitest';
import { parseAnsi, stripAnsi } from './ansi.js';

const ESC = '\u001b';

describe('parseAnsi', () => {
  it('returns one plain span for text without codes', () => {
    expect(parseAnsi('hello')).toEqual([{ text: 'hello', classes: [] }]);
  });

  it('maps the basic and bright foregrounds and resets', () => {
    expect(parseAnsi(`${ESC}[31merror${ESC}[0m done`)).toEqual([
      { text: 'error', classes: ['ansi-fg-red'] },
      { text: ' done', classes: [] },
    ]);
    expect(parseAnsi(`${ESC}[92mok${ESC}[m`)).toEqual([
      { text: 'ok', classes: ['ansi-fg-bright-green'] },
    ]);
  });

  it('treats bold on a colour as bright and keeps bold as its own class', () => {
    expect(parseAnsi(`${ESC}[1;34mtitle`)).toEqual([
      { text: 'title', classes: ['ansi-fg-bright-blue', 'ansi-bold'] },
    ]);
    expect(parseAnsi(`${ESC}[1mstrong${ESC}[22m normal`)).toEqual([
      { text: 'strong', classes: ['ansi-bold'] },
      { text: ' normal', classes: [] },
    ]);
  });

  it('handles backgrounds, dim, underline and the default-colour codes', () => {
    expect(parseAnsi(`${ESC}[43;2;4mx${ESC}[39;49;24;22my`)).toEqual([
      { text: 'x', classes: ['ansi-bg-yellow', 'ansi-dim', 'ansi-underline'] },
      { text: 'y', classes: [] },
    ]);
  });

  it('reads 256-colour codes for the first sixteen and ignores the rest', () => {
    expect(parseAnsi(`${ESC}[38;5;9mred${ESC}[38;5;200mother${ESC}[38;2;1;2;3mrgb`)).toEqual([
      { text: 'red', classes: ['ansi-fg-bright-red'] },
      { text: 'otherrgb', classes: [] },
    ]);
  });

  it('drops cursor movement, erase and OSC sequences', () => {
    expect(parseAnsi(`${ESC}[2K${ESC}[1Gline${ESC}]0;title${'\u0007'} end`)).toEqual([
      { text: 'line end', classes: [] },
    ]);
  });

  it('merges adjacent spans with the same style', () => {
    expect(parseAnsi(`${ESC}[31ma${ESC}[31mb`)).toEqual([{ text: 'ab', classes: ['ansi-fg-red'] }]);
  });
});

describe('stripAnsi', () => {
  it('leaves only the text', () => {
    expect(stripAnsi(`${ESC}[31mred${ESC}[0m and ${ESC}[2Kplain`)).toBe('red and plain');
  });
});
