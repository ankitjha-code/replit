import { StringDecoder } from 'node:string_decoder';
import type { OutputStream } from '@platform/shared';

export interface OutputLine {
  stream: OutputStream;
  data: string;
  at: string;
}

export class OutputBuffer {
  private readonly lines: OutputLine[] = [];
  private bytes = 0;
  private dropped = false;

  private readonly decoders: Record<OutputStream, StringDecoder> = {
    stdout: new StringDecoder('utf8'),
    stderr: new StringDecoder('utf8'),
  };

  constructor(
    private readonly maxBytes: number,
    private readonly maxLines: number,
  ) {}

  append(stream: OutputStream, chunk: Uint8Array): OutputLine | undefined {
    const data = this.decoders[stream].write(Buffer.from(chunk));
    if (data.length === 0) return undefined;

    const line: OutputLine = { stream, data, at: new Date().toISOString() };

    this.lines.push(line);
    this.bytes += Buffer.byteLength(data, 'utf8');
    this.trim();

    return line;
  }

  read(): { lines: OutputLine[]; truncated: boolean } {
    return { lines: [...this.lines], truncated: this.dropped };
  }

  private trim(): void {
    while (this.lines.length > this.maxLines || this.bytes > this.maxBytes) {
      const removed = this.lines.shift();
      if (!removed) break;
      this.bytes -= Buffer.byteLength(removed.data, 'utf8');
      this.dropped = true;
    }
  }
}
