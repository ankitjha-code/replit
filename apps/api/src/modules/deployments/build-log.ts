/**
 * What a build printed, bounded.
 *
 * A build runs a command somebody wrote, so it can print for as long as it
 * runs. Keeping all of it would make one verbose build able to fill the
 * database; keeping none would throw away the only useful thing about a failed
 * one.
 *
 * So the **tail** is kept, not the head. A build fails at the end, and the last
 * thing it printed is the reason. Somebody reading a truncated log wants the
 * error, not the banner from the package manager.
 */
export class BuildLog {
  private readonly chunks: string[] = [];
  private bytes = 0;

  /** True once the start of the output was dropped to stay inside the limit. */
  truncated = false;

  constructor(private readonly maxBytes: number) {}

  write(chunk: string): void {
    if (chunk.length === 0) return;

    this.chunks.push(chunk);
    this.bytes += Buffer.byteLength(chunk, 'utf8');
    this.trim();
  }

  text(): string {
    return this.chunks.join('');
  }

  /**
   * Drops whole chunks from the front until the tail fits.
   *
   * Whole chunks, so the result never ends up starting mid-character: a chunk
   * arrived already decoded, and cutting one in half by byte count is how a log
   * grows replacement marks.
   */
  private trim(): void {
    while (this.bytes > this.maxBytes && this.chunks.length > 1) {
      const dropped = this.chunks.shift();
      this.bytes -= Buffer.byteLength(dropped ?? '', 'utf8');
      this.truncated = true;
    }

    if (this.bytes <= this.maxBytes) return;

    /*
     * One chunk, still too large.
     *
     * A single write bigger than the whole budget, which a build that prints a
     * megabyte on one line will produce. Cut by characters from the end rather
     * than by bytes, so what survives is still text.
     */
    const only = this.chunks[0] ?? '';
    const kept = only.slice(-this.maxBytes);

    this.chunks[0] = kept;
    this.bytes = Buffer.byteLength(kept, 'utf8');
    this.truncated = true;
  }
}
