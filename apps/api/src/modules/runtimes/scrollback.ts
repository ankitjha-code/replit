import { StringDecoder } from 'node:string_decoder';

export class Scrollback {
  private chunks: string[] = [];
  private bytes = 0;
  private dropped = false;

  private readonly decoder = new StringDecoder('utf8');

  constructor(private readonly maxBytes: number) {}

  append(chunk: Uint8Array): string {
    const text = this.decoder.write(Buffer.from(chunk));
    if (text.length === 0) return '';
    this.push(text);
    return text;
  }

  end(): string {
    const tail = this.decoder.end();
    if (tail.length > 0) this.push(tail);
    return tail;
  }

  read(): { text: string; truncated: boolean } {
    return { text: this.chunks.join(''), truncated: this.dropped };
  }

  private push(text: string): void {
    this.chunks.push(text);
    this.bytes += Buffer.byteLength(text, 'utf8');
    this.trim();
  }

  private trim(): void {
    while (this.bytes > this.maxBytes && this.chunks.length > 1) {
      const removed = this.chunks.shift();
      if (removed === undefined) break;
      this.bytes -= Buffer.byteLength(removed, 'utf8');
      this.dropped = true;
    }

    if (this.bytes <= this.maxBytes) return;

    const only = this.chunks[0] ?? '';
    const buffer = Buffer.from(only, 'utf8');
    let kept = buffer.subarray(buffer.length - this.maxBytes).toString('utf8');
    if (kept.charCodeAt(0) === 0xfffd) kept = kept.slice(1);

    this.chunks = [kept];
    this.bytes = Buffer.byteLength(kept, 'utf8');
    this.dropped = true;
  }
}
