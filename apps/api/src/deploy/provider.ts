import type { ResourceLimits } from '@platform/shared';
import type { WorkspaceEntry, WorkspaceFile } from '../execution/provider.js';

/**
 * The boundary between the platform and whatever builds and serves a
 * deployment.
 *
 * The third port of this shape, after execution and storage, and deliberately
 * the same one: the platform decides what should exist, something else makes it
 * exist, and an installation with nothing behind the port says so rather than
 * pretending.
 *
 * It has two halves, and they are separate because the two targets need
 * different amounts of it:
 *
 *  - **Building** turns a project's source into what will be served. Both
 *    targets may need it, because a static site is often a build step and a
 *    server often has one too.
 *  - **Serving a process** is only for a server deployment. A static site needs
 *    nothing running at all once it is built: the platform holds the bytes and
 *    answers requests for them itself, which is why a static deployment keeps
 *    working while the execution backend is down.
 *
 * ## Rules any implementation must keep
 *
 * 1. **Nothing is reported deployed that was not observed deployed.** The same
 *    rule the execution provider has. A status is written after the provider
 *    says so, never because a request was sent.
 * 2. **A build reads the files it is handed**, which came from a snapshot, and
 *    never the project's live files. A deployment that rebuilt itself from
 *    whatever the editor contains would not be a version of anything.
 * 3. **A build is bounded.** In time, in output size, and in the resources the
 *    container gets. It runs a command somebody wrote; it must not be able to
 *    run for ever or fill the disk.
 * 4. **A deployment is unreachable from the platform's own origin**, exactly as
 *    a preview is, because it serves somebody else's code to the public.
 * 5. **Stopping something already stopped succeeds.** Cleanup depends on it.
 */

/** What the build is asked to turn into something servable. */
export interface BuildSpec {
  deploymentId: string;
  projectId: string;

  /** The image to build in, from the project's detected runtime. */
  image: string;

  /** The project's files, as they were in the snapshot this deployment pins. */
  entries: readonly WorkspaceEntry[];

  /** The command to run, or null when there is nothing to build. */
  buildCommand: string | null;

  /**
   * What to take away afterwards, relative to the project root.
   *
   * A directory for a static site: only that is kept. Null for a server, where
   * the whole tree is what runs.
   */
  outputDirectory: string | null;

  /**
   * The environment the build runs with.
   *
   * The project's own variables and secrets. A build reads configuration —
   * an API base URL is compiled into a static site — so withholding them would
   * produce a build that differs from the one that works locally.
   */
  environment: Readonly<Record<string, string>>;

  limits: ResourceLimits;

  /** Called as the build prints. The caller decides what to keep. */
  onLog: (chunk: string) => void;
}

/** A workload a build has happened in, which may still have work to do. */
export interface BuildHandle {
  externalId: string;
  /**
   * Which machine it was placed on, when the provider chose between several.
   *
   * Recorded by the caller so the scheduler can count what each host carries.
   * Never read back in: finding the workload again uses the identifier.
   */
  host?: string;
}

export interface BuildResult {
  /** The contents of the output directory, with that directory stripped off. */
  files: WorkspaceFile[];
}

/**
 * What the provider is asked to keep running.
 *
 * No files: a server is served out of the same workload it was built in, so its
 * dependencies stay where they were installed. Carrying a built tree between
 * containers would mean moving `node_modules` through the control plane, which
 * is hundreds of megabytes for no gain.
 */
export interface ServeSpec {
  deploymentId: string;
  /** The command that starts the application, run inside the workload. */
  startCommand: string;
  environment: Readonly<Record<string, string>>;

  /**
   * Called as the deployment prints, for as long as this process is watching.
   *
   * A deployment outlives the request that started it, so this is the only
   * chance to see what it says: nothing reattaches after a restart, and there is
   * no terminal into a deployment. What the caller does with it is the caller's
   * business; what matters here is that the stream is not thrown away the
   * moment the site answers its first request.
   */
  onOutput?: (output: { stream: 'stdout' | 'stderr'; chunk: string }) => void;

  /**
   * Called when the deployed program ends.
   *
   * Which is the only way the platform ever finds out. Nothing polls a
   * deployment and nothing restarts one, so a process that exits is invisible
   * unless somebody is still holding its stream.
   */
  onExit?: (code: number | null) => void;
}

/** What the provider made, once it has made it. */
export interface DeploymentHandle {
  /** The provider's own identifier for whatever is serving this. */
  externalId: string;
  /** The port inside the workload that answered, once one did. */
  containerPort: number;
}

/** Where the platform can reach a running deployment, on this machine only. */
export interface DeploymentTarget {
  host: string;
  port: number;
  containerPort: number;
}

export interface DeploymentProvider {
  /** Recorded on the deployment row, because a handle from one means nothing to another. */
  readonly name: string;

  /**
   * Why deployments cannot be made here, or null when they can.
   *
   * Asked before anything is written, so an installation with no backend never
   * accumulates rows describing deployments that will never exist.
   */
  unavailableReason(): Promise<string | null>;

  /**
   * Creates a workload, puts the project in it, and runs the build command.
   *
   * Throws with a message safe to show when the build fails, having already
   * streamed the reason through `onLog`: what a failed build printed is the
   * only useful thing about it. The workload survives a success, because what
   * happens next depends on the target, and is cleaned up on a failure by the
   * provider itself — the caller never had a handle for it.
   */
  build(spec: BuildSpec): Promise<BuildHandle>;

  /**
   * Takes a static build's output away, so the workload can be discarded.
   *
   * Only the named directory, and everything in it. What comes back is what the
   * platform will store and serve.
   */
  collect(handle: BuildHandle, outputDirectory: string): Promise<BuildResult>;

  /**
   * Starts a server deployment and waits until it actually answers.
   *
   * Resolving means something responded on a port, not that a process was
   * spawned. The execution plane already refuses to report a runtime running on
   * weaker evidence than that, and a deployment shown as live in front of a
   * blank page is worse, because nobody is watching it.
   */
  serve(handle: BuildHandle, spec: ServeSpec): Promise<DeploymentHandle>;

  /** Where to reach a running deployment, or null when nothing is there. */
  target(handle: { externalId: string; containerPort: number }): Promise<DeploymentTarget | null>;

  /** Stops one. Succeeds when it is already stopped. */
  stop(handle: { externalId: string }): Promise<void>;

  /** Removes whatever the provider holds for it. Succeeds when already gone. */
  destroy(handle: { externalId: string }): Promise<void>;

  /** Bytes a running deployment has written to its filesystem, or null. */
  diskUsage(handle: { externalId: string }): Promise<number | null>;
}
