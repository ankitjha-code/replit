import { StringDecoder } from 'node:string_decoder';
import type { OutputStream } from '@platform/shared';

/**
 * What the application has printed recently.
 *
 * Someone who opens the console after a program started still needs to see why
 * it failed, so recent output is kept. It is kept in memory and bounded, which
 * are both honest limits rather than oversights: this is a window onto a
 * running program, not a log. Durable logs are their own task, and until they
 * exist the platform says when it has dropped something rather than presenting
 * a partial log as a whole one.
 */

export interface OutputLine {
  stream: OutputStream;
  data: string;
  at: string;
}

export class OutputBuffer {
  private readonly lines: OutputLine[] = [];
  private bytes = 0;
  private dropped = false;

  /**
   * One decoder per stream.
   *
   * A chunk boundary can fall in the middle of a multi-byte character, and
   * decoding each chunk on its own turns that into a replacement character on
   * screen. Two decoders rather than one, because the streams interleave and a
   * shared decoder would join the tail of one to the head of the other.
   */
  private readonly decoders: Record<OutputStream, StringDecoder> = {
    stdout: new StringDecoder('utf8'),
    stderr: new StringDecoder('utf8'),
  };

  constructor(
    private readonly maxBytes: number,
    private readonly maxLines: number,
  ) {}

  /**
   * Records a chunk, and returns what a live listener should be sent.
   *
   * Returns nothing when a chunk decoded to nothing, which happens when it
   * ended mid-character: the rest arrives with the next one.
   */
  append(stream: OutputStream, chunk: Uint8Array): OutputLine | undefined {
    const data = this.decoders[stream].write(Buffer.from(chunk));
    if (data.length === 0) return undefined;

    const line: OutputLine = { stream, data, at: new Date().toISOString() };

    this.lines.push(line);
    this.bytes += Buffer.byteLength(data, 'utf8');
    this.trim();

    return line;
  }

  /** Everything still held, and whether anything older was dropped. */
  read(): { lines: OutputLine[]; truncated: boolean } {
    return { lines: [...this.lines], truncated: this.dropped };
  }

  private trim(): void {
    while (this.lines.length > this.maxLines || this.bytes > this.maxBytes) {
      const removed = this.lines.shift();
      if (!removed) break;
      this.bytes -= Buffer.byteLength(removed.data, 'utf8');
      // Recorded once and never unset: a client that connects later is told
      // that what it can see is not everything.
      this.dropped = true;
    }
  }
}
