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

  /**
   * How many chunks have been written. Grows with every write, so a saver can
   * tell new output from none even after trimming kept the size the same.
   */
  writes = 0;

  constructor(private readonly maxBytes: number) {}

  write(chunk: string): void {
    if (chunk.length === 0) return;

    this.writes += 1;
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

/**
 * Saves a running build's log every `everyMs`, so it can be read before the
 * build ends.
 *
 * On a timer rather than per chunk: a build that prints a line at a time would
 * otherwise be one database write per line. A tick with no new output, or one
 * that arrives while the previous save is still running, does nothing.
 *
 * `save` must not reject; the caller decides what a failed save means. `stop`
 * waits for a save in flight, so the final save that follows it cannot be
 * overtaken by an older one.
 */
export function saveWhileRunning(
  log: BuildLog,
  save: () => Promise<void>,
  everyMs: number,
): { stop(): Promise<void> } {
  let savedWrites = log.writes;
  let saving: Promise<void> | null = null;

  const timer = setInterval(() => {
    if (saving || log.writes === savedWrites) return;
    savedWrites = log.writes;
    saving = save().finally(() => {
      saving = null;
    });
  }, everyMs);
  // A build in progress must not keep the process alive on its own.
  timer.unref();

  return {
    async stop() {
      clearInterval(timer);
      await saving;
    },
  };
}
