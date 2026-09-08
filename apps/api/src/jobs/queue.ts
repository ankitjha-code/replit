/**
 * The boundary between the platform and however workers are told there is work.
 *
 * Smaller than it looks, and deliberately. This is **not** where jobs live: they
 * live in the database, which is the authority on what is outstanding exactly as
 * it is for everything else in this platform. All this carries is a nudge.
 *
 * That split is the whole design, and it buys three things:
 *
 *  - **Nothing is lost when the queue is.** A worker that missed every nudge
 *    still finds the same work by looking, so the worst a queue outage costs is
 *    latency.
 *  - **There is one answer to "what is outstanding".** A queue holding jobs
 *    would be a second store that can disagree with the first, and it would be
 *    the one that empties on restart.
 *  - **The queue is optional.** An installation with no Redis runs an in-process
 *    notifier and works; Redis makes the nudge cross a process boundary.
 *
 * ## Rules any implementation must keep
 *
 * 1. **A nudge is advice, never a fact.** Losing one must be survivable, and
 *    delivering one twice must be harmless. Both follow from the database
 *    deciding what is claimable.
 * 2. **Nothing is acknowledged.** There is no delivery guarantee to keep,
 *    because nothing depends on delivery.
 * 3. **Failures are not the caller's problem.** Publishing happens after work
 *    has been recorded; a nudge that could fail an enqueue would make the
 *    optional part able to break the essential one.
 */

export interface JobQueue {
  /** Recorded in logs and health, because one that is not working matters. */
  readonly name: string;

  /**
   * Why nudges cannot be delivered right now, or null when they can.
   *
   * Not fatal to anything: a platform whose queue is unreachable is a platform
   * where work is picked up on the next poll instead of immediately. Reported so
   * an operator can see the difference between "slow" and "broken".
   */
  unavailableReason(): Promise<string | null>;

  /**
   * Says there is work. Never throws, and never waits for anybody to hear it.
   */
  publish(): void;

  /**
   * Calls back when somebody says there is work.
   *
   * The listener takes no argument. It is told that something happened, not
   * what: a worker then asks the database, which is the only thing that can say
   * whether the work is still there and still unclaimed.
   */
  subscribe(listener: () => void): () => void;

  close(): Promise<void>;
}
