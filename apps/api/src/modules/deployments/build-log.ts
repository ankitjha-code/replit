export class BuildLog {
  private readonly chunks: string[] = [];
  private bytes = 0;

  truncated = false;

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

  private trim(): void {
    while (this.bytes > this.maxBytes && this.chunks.length > 1) {
      const dropped = this.chunks.shift();
      this.bytes -= Buffer.byteLength(dropped ?? '', 'utf8');
      this.truncated = true;
    }

    if (this.bytes <= this.maxBytes) return;

    const only = this.chunks[0] ?? '';
    const kept = only.slice(-this.maxBytes);

    this.chunks[0] = kept;
    this.bytes = Buffer.byteLength(kept, 'utf8');
    this.truncated = true;
  }
}

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
  timer.unref();

  return {
    async stop() {
      clearInterval(timer);
      await saving;
    },
  };
}
