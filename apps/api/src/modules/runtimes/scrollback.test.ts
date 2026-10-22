import { describe, expect, it } from 'vitest';
import { Scrollback } from './scrollback.js';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('what a shell printed', () => {
  it('keeps what it was given, in order', () => {
    const buffer = new Scrollback(1024);
    buffer.append(bytes('one '));
    buffer.append(bytes('two'));
    expect(buffer.read()).toEqual({ text: 'one two', truncated: false });
  });

  it('returns the text a live socket should be sent', () => {
    const buffer = new Scrollback(1024);
    expect(buffer.append(bytes('hello'))).toBe('hello');
  });

  it('starts empty rather than undefined', () => {
    expect(new Scrollback(1024).read()).toEqual({ text: '', truncated: false });
  });
});

describe('a character split across two chunks', () => {
  it('is held until the rest of it arrives', () => {
    const buffer = new Scrollback(1024);
    // The euro sign is three bytes. Decoding either half alone produces a
    // replacement character, which would then be kept in the scrollback for
    // as long as the session lives.
    const euro = bytes('€');
    const first = buffer.append(euro.slice(0, 2));
    const second = buffer.append(euro.slice(2));

    expect(first).toBe('');
    expect(second).toBe('€');
    expect(buffer.read().text).toBe('€');
  });

  it('gives up the tail when the shell ends', () => {
    const buffer = new Scrollback(1024);
    buffer.append(bytes('€').slice(0, 2));
    // A truncated character at the very end is real: the shell died
    // mid-character. What comes back is what the decoder makes of it, and the
    // point is that it is flushed rather than silently dropped.
    expect(buffer.end().length).toBeGreaterThan(0);
  });
});

describe('the window', () => {
  it('drops the oldest bytes once it is full', () => {
    const buffer = new Scrollback(10);
    buffer.append(bytes('aaaaa'));
    buffer.append(bytes('bbbbb'));
    buffer.append(bytes('ccccc'));

    const { text } = buffer.read();
    expect(text).toBe('bbbbbccccc');
    expect(text).not.toContain('a');
  });

  it('says so once it has dropped anything', () => {
    // A partial screen presented as a whole one is how someone concludes a
    // command printed nothing.
    const buffer = new Scrollback(4);
    buffer.append(bytes('aaaa'));
    expect(buffer.read().truncated).toBe(false);

    buffer.append(bytes('bbbb'));
    expect(buffer.read().truncated).toBe(true);
  });

  it('never unsays it, even once the dropped bytes are long gone', () => {
    const buffer = new Scrollback(4);
    buffer.append(bytes('aaaa'));
    buffer.append(bytes('bbbb'));
    buffer.append(bytes('cccc'));
    expect(buffer.read().truncated).toBe(true);
  });

  it('keeps the tail of a single chunk larger than the whole window', () => {
    // A build that prints one enormous line must not empty the screen: the
    // end of it is the part a person is looking for.
    const buffer = new Scrollback(5);
    buffer.append(bytes('0123456789'));

    const { text, truncated } = buffer.read();
    expect(text).toBe('56789');
    expect(truncated).toBe(true);
  });

  it('holds a chunk that exactly fills it without calling it truncated', () => {
    const buffer = new Scrollback(5);
    buffer.append(bytes('12345'));
    expect(buffer.read()).toEqual({ text: '12345', truncated: false });
  });
});
