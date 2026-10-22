import type { WorkloadUsage } from '@platform/shared';

/**
 * Recent readings for one workload, held in memory.
 *
 * A window rather than a record, and the distinction is deliberate. Writing a
 * sample per workload per interval into the database would be the platform's
 * highest-volume write by a wide margin, for data whose value collapses within
 * minutes: nobody asks what a container's processor use was last Tuesday, they
 * ask whether it is climbing now.
 *
 * So the trend starts when the control plane starts and is gone when the
 * process is, exactly like the console's output buffer, and the page that shows
 * it says so rather than implying a history it does not have.
 *
 * Bounded by count. A window that grew with uptime would be a slow leak on a
 * long-running installation, which is the one where it would matter.
 */
export class UsageWindow {
  private readonly samples: WorkloadUsage[] = [];

  constructor(private readonly capacity: number) {}

  push(sample: WorkloadUsage): void {
    this.samples.push(sample);
    while (this.samples.length > this.capacity) this.samples.shift();
  }

  /** Oldest first, which is the direction a trend is read in. */
  read(): WorkloadUsage[] {
    return [...this.samples];
  }

  /** The most recent reading, or null before there is one. */
  latest(): WorkloadUsage | null {
    return this.samples[this.samples.length - 1] ?? null;
  }

  get size(): number {
    return this.samples.length;
  }
}

/**
 * Every workload's window, keyed by the workload's own identifier.
 *
 * Entries are dropped when a workload stops being sampled rather than left to
 * accumulate: a project started and stopped a hundred times would otherwise
 * leave a hundred windows behind, each holding readings for a container that no
 * longer exists.
 */
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

  /** Forgets everything except the workloads named. */
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
