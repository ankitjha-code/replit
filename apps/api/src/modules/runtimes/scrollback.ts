import { StringDecoder } from 'node:string_decoder';

/**
 * What a shell has printed, kept so a screen can be rebuilt.
 *
 * A terminal that survives a reload is only useful if what was on it survives
 * too. Reattaching to a live shell and being shown an empty rectangle is worse
 * than opening a new one, because the shell's state is now invisible: the
 * directory it is in, the output of the command that is still running, the
 * prompt half typed into.
 *
 * This is a byte window, not a log. It holds the tail and says when it has
 * dropped the head, because a partial screen presented as a whole one is how
 * someone concludes a command printed nothing.
 *
 * Text rather than lines, unlike the application output buffer. A shell's
 * stream is not lines: it is interleaved escape sequences that move a cursor,
 * repaint a region and set a colour, and splitting it on newlines would cut
 * those in half.
 */
export class Scrollback {
  private chunks: string[] = [];
  private bytes = 0;
  private dropped = false;

  /**
   * Holds the tail of a chunk that ended mid-character.
   *
   * A chunk boundary can fall inside a multi-byte character, and decoding each
   * chunk on its own turns that into a replacement character that is then kept
   * forever in the scrollback.
   */
  private readonly decoder = new StringDecoder('utf8');

  constructor(private readonly maxBytes: number) {}

  /**
   * Records a chunk, and returns the text a live socket should be sent.
   *
   * Returns an empty string when the chunk decoded to nothing, which happens
   * when it ended mid-character: the rest arrives with the next one.
   */
  append(chunk: Uint8Array): string {
    const text = this.decoder.write(Buffer.from(chunk));
    if (text.length === 0) return '';
    this.push(text);
    return text;
  }

  /** Anything the decoder was still holding when the shell ended. */
  end(): string {
    const tail = this.decoder.end();
    if (tail.length > 0) this.push(tail);
    return tail;
  }

  /** The whole window as one string, and whether anything older was dropped. */
  read(): { text: string; truncated: boolean } {
    return { text: this.chunks.join(''), truncated: this.dropped };
  }

  private push(text: string): void {
    this.chunks.push(text);
    this.bytes += Buffer.byteLength(text, 'utf8');
    this.trim();
  }

  private trim(): void {
    /*
     * Down to one chunk, never to none.
     *
     * Stopping at one matters: a single chunk can be larger than the whole
     * window on its own, and dropping it would leave an empty screen. The tail
     * of it is exactly the part someone is looking for, so it is cut rather
     * than discarded.
     */
    while (this.bytes > this.maxBytes && this.chunks.length > 1) {
      const removed = this.chunks.shift();
      if (removed === undefined) break;
      this.bytes -= Buffer.byteLength(removed, 'utf8');
      // Recorded once and never unset. A client that resumes later is told
      // that what it can see is not everything.
      this.dropped = true;
    }

    if (this.bytes <= this.maxBytes) return;

    const only = this.chunks[0] ?? '';
    /*
     * Cut by bytes, because the limit is in bytes.
     *
     * Slicing by characters would overshoot on any text that is not ASCII, and
     * a cut can land inside a character: the decoder marks that with a
     * replacement character, which is dropped rather than left at the top of
     * someone's screen.
     */
    const buffer = Buffer.from(only, 'utf8');
    let kept = buffer.subarray(buffer.length - this.maxBytes).toString('utf8');
    if (kept.charCodeAt(0) === 0xfffd) kept = kept.slice(1);

    this.chunks = [kept];
    this.bytes = Buffer.byteLength(kept, 'utf8');
    this.dropped = true;
  }
}
