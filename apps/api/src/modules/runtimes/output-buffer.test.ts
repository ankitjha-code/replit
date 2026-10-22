import { describe, expect, it } from 'vitest';
import { OutputBuffer } from './output-buffer.js';

const encode = (text: string) => new TextEncoder().encode(text);

describe('recording output', () => {
  it('keeps what was printed, with the stream it came from', () => {
    const buffer = new OutputBuffer(1024, 100);
    buffer.append('stdout', encode('listening on 3000\n'));
    buffer.append('stderr', encode('a warning\n'));

    const { lines } = buffer.read();
    expect(lines.map((line) => [line.stream, line.data])).toEqual([
      ['stdout', 'listening on 3000\n'],
      ['stderr', 'a warning\n'],
    ]);
  });

  it('returns the line a live watcher should be sent', () => {
    const buffer = new OutputBuffer(1024, 100);
    expect(buffer.append('stdout', encode('hello'))?.data).toBe('hello');
  });

  it('says nothing was dropped when nothing was', () => {
    const buffer = new OutputBuffer(1024, 100);
    buffer.append('stdout', encode('a line\n'));
    expect(buffer.read().truncated).toBe(false);
  });
});

describe('characters split across chunks', () => {
  it('waits for the rest of a character rather than corrupting it', () => {
    const buffer = new OutputBuffer(1024, 100);
    const bytes = encode('é');

    expect(buffer.append('stdout', bytes.subarray(0, 1))).toBeUndefined();
    expect(buffer.append('stdout', bytes.subarray(1))?.data).toBe('é');
    expect(
      buffer
        .read()
        .lines.map((line) => line.data)
        .join(''),
    ).toBe('é');
  });

  it('keeps the two streams apart while doing it', () => {
    const buffer = new OutputBuffer(1024, 100);
    const out = encode('ü');
    const err = encode('ö');

    buffer.append('stdout', out.subarray(0, 1));
    buffer.append('stderr', err.subarray(0, 1));
    expect(buffer.append('stdout', out.subarray(1))?.data).toBe('ü');
    expect(buffer.append('stderr', err.subarray(1))?.data).toBe('ö');
  });
});

describe('when there is more output than room', () => {
  it('drops the oldest and says so', () => {
    const buffer = new OutputBuffer(1024, 2);
    buffer.append('stdout', encode('first\n'));
    buffer.append('stdout', encode('second\n'));
    buffer.append('stdout', encode('third\n'));

    const { lines, truncated } = buffer.read();
    expect(lines.map((line) => line.data)).toEqual(['second\n', 'third\n']);
    expect(truncated).toBe(true);
  });

  it('drops by size as well as by count', () => {
    const buffer = new OutputBuffer(20, 1000);
    buffer.append('stdout', encode('x'.repeat(15)));
    buffer.append('stdout', encode('y'.repeat(15)));

    const { lines, truncated } = buffer.read();
    expect(lines).toHaveLength(1);
    expect(lines[0]?.data.startsWith('y')).toBe(true);
    expect(truncated).toBe(true);
  });

  it('goes on saying so after the fact', () => {
    const buffer = new OutputBuffer(1024, 1);
    buffer.append('stdout', encode('a\n'));
    buffer.append('stdout', encode('b\n'));
    expect(buffer.read().truncated).toBe(true);
  });
});
