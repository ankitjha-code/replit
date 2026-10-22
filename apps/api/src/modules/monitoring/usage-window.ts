import type { WorkloadUsage } from '@platform/shared';

export class UsageWindow {
  private readonly samples: WorkloadUsage[] = [];

  constructor(private readonly capacity: number) {}

  push(sample: WorkloadUsage): void {
    this.samples.push(sample);
    while (this.samples.length > this.capacity) this.samples.shift();
  }

  read(): WorkloadUsage[] {
    return [...this.samples];
  }

  latest(): WorkloadUsage | null {
    return this.samples[this.samples.length - 1] ?? null;
  }

  get size(): number {
    return this.samples.length;
  }
}

export class UsageWindows {
  private readonly windows = new Map<string, UsageWindow>();

  constructor(private readonly capacity: number) {}

  record(workloadId: string, sample: WorkloadUsage): void {
    const window = this.windows.get(workloadId) ?? new UsageWindow(this.capacity);
    window.push(sample);
    this.windows.set(workloadId, window);
  }

  read(workloadId: string): WorkloadUsage[] {
    return this.windows.get(workloadId)?.read() ?? [];
  }

  latest(workloadId: string): WorkloadUsage | null {
    return this.windows.get(workloadId)?.latest() ?? null;
  }

  retain(workloadIds: Iterable<string>): void {
    const keep = new Set(workloadIds);
    for (const id of [...this.windows.keys()]) {
      if (!keep.has(id)) this.windows.delete(id);
    }
  }

  forget(workloadId: string): void {
    this.windows.delete(workloadId);
  }

  get watched(): number {
    return this.windows.size;
  }
}
