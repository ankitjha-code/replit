import type { ResourceLimits, TerminalSize } from '@platform/shared';

/**
 * The boundary between the control plane and the execution plane.
 *
 * Everything above this interface reasons about a runtime as a row with a
 * status. Everything below it deals in containers. Nothing outside this
 * directory may import a container SDK or spawn a process, which is enforced
 * by lint rather than left to discipline.
 *
 * ## Rules any implementation must keep
 *
 * 1. **User code never runs on the control plane host.** A provider that
 *    executes a command outside its isolation boundary has defeated the entire
 *    point of the split.
 * 2. **The container runtime's socket is never handed to a workload.** A
 *    workload that can reach it can create a privileged container and own the
 *    machine. The provider talks to the socket; the workload never sees it.
 * 3. **Limits are not advisory.** Every workload is created with the CPU,
 *    memory and process ceilings it was given. A provider that cannot enforce
 *    one must fail rather than start something unbounded.
 * 4. **A container is not storage.** Project files live in the platform
 *    database. A provider may copy them in and read changes back out, but
 *    destroying every workload on the host must lose nothing.
 * 5. **Operations are idempotent where they can be.** Stopping something
 *    already stopped succeeds. Reconciliation depends on it.
 */

/**
 * One entry to place inside a workload's workspace.
 *
 * Content is null for a directory. The bytes come from the platform database,
 * which is the source of truth for a project's source: a provider copies them
 * in, and may later read changes back out, but destroying every workload on
 * the host must lose nothing.
 */
export interface WorkspaceEntry {
  /** Project-relative, normalised, with no leading separator. */
  path: string;
  content: Uint8Array | null;
}

/** One file read back out of a workload. */
export interface WorkspaceFile {
  /** Project-relative, with no leading separator. */
  path: string;
  content: Uint8Array;
}

/**
 * An interactive session attached to a running workload.
 *
 * A real pseudo-terminal, not a pipe. Line editing, job control, colour and
 * the shell's own prompt all depend on the process believing it has a
 * terminal, and a person typing into a pipe gets none of them.
 *
 * The session owns nothing above it: closing the socket closes the session,
 * and the process ending closes the socket. Neither outlives the other.
 */
export interface TerminalSession {
  /** Bytes the process produced. Not decoded: a chunk can split a character. */
  onData(listener: (chunk: Uint8Array) => void): void;
  /** The process ended. The code is null when the provider could not learn it. */
  onExit(listener: (code: number | null) => void): void;
  /** Keystrokes, delivered to the process's standard input unchanged. */
  write(data: string): void;
  resize(size: TerminalSize): Promise<void>;
  close(): Promise<void>;
}

export interface TerminalOptions {
  size: TerminalSize;
  /** Where the session starts. Defaults to the workload's own working directory. */
  cwd?: string;
}

/**
 * Where the platform can reach a port the workload is listening on.
 *
 * An address on the platform's own machine, not on the network. The container
 * is never reachable from outside; this is the door the platform's proxy uses
 * and nothing else.
 */
export interface PublishedPort {
  /** The port as the application inside the workload sees it. */
  containerPort: number;
  host: string;
  port: number;
}

/**
 * One chunk the application printed, and which stream it came from.
 *
 * Kept apart because they mean different things to a person reading them, and
 * merging them is a decision for whatever displays them rather than for the
 * thing that reads them.
 */
export interface ProcessOutput {
  stream: 'stdout' | 'stderr';
  chunk: Uint8Array;
}

/**
 * The application running inside a workload.
 *
 * Detaching is not stopping. A control plane that restarts must be able to let
 * go of the stream without killing the program, because the program belongs to
 * the container and not to the connection watching it.
 */
export interface RunningProcess {
  onOutput(listener: (output: ProcessOutput) => void): void;
  /** The program ended. Null when the provider could not learn the code. */
  onExit(listener: (code: number | null) => void): void;
  /** Stops watching. Leaves the program running. */
  detach(): Promise<void>;
}

export interface StartProcessOptions {
  /** A shell command, run inside the workload and nowhere else. */
  command: string;
  /** Where it runs. Defaults to the workload's own working directory. */
  cwd?: string;
  env?: Readonly<Record<string, string>>;
}

/**
 * A workload the provider has created, addressed by the provider's own id.
 *
 * `externalId` is **opaque above this line**. A provider that spreads work
 * across several machines encodes which one into it, so that finding a workload
 * later needs nothing but the value the platform already stores; a single-host
 * provider uses the container id unchanged. Nothing outside this directory may
 * interpret it.
 */
export interface ExecutionHandle {
  externalId: string;

  /**
   * Which machine it was placed on, when the provider chose between several.
   *
   * Returned from `create` only, and only so the caller can write it down: the
   * platform counts placed workloads per host in order to schedule the next one,
   * and counting by parsing an opaque identifier would make the encoding
   * something everybody depends on. Never read back in; routing uses the
   * identifier.
   */
  host?: string;
}

/**
 * What a workload is for.
 *
 * A development runtime and a deployment are both containers and are not the
 * same thing: one idles until somebody runs something in it and is torn down
 * constantly, the other runs one program and is meant to stay up. They are told
 * apart here rather than by convention, because a cleanup query that could not
 * distinguish them would eventually remove somebody's running site.
 */
export type WorkloadKind = 'runtime' | 'deployment';

export interface ProvisionRequest {
  /**
   * The row this workload belongs to, for naming and for tracing.
   *
   * A runtime id or a deployment id, depending on `kind`. Never a project id: a
   * project outlives its workloads and reusing its identifier would make two
   * generations of container indistinguishable.
   */
  workloadId: string;
  kind: WorkloadKind;
  projectId: string;
  image: string;
  limits: ResourceLimits;

  /**
   * What the container runs, for a workload that runs one thing.
   *
   * Absent for a development runtime, which is an environment rather than a
   * program: it idles, and what runs in it arrives later as an exec. Present
   * for a deployment, where the program is the point and the container ending
   * when the program ends is the behaviour that makes a dead site observable.
   */
  command?: string | undefined;
  /**
   * Environment for the workload.
   *
   * Only what the project itself declared. Platform configuration, database
   * credentials and session secrets are not passed here and must never be:
   * the workload runs code the platform did not write.
   */
  env: Readonly<Record<string, string>>;
}

/**
 * What one workload is consuming, as the execution plane measures it.
 *
 * Every field is nullable because every one of them can be unavailable
 * separately: a container runtime that reports memory may report no process
 * count, and a reading that is missing must never arrive as a zero.
 */
export interface WorkloadStats {
  /** Processor use as a share of one core, in millicores. */
  cpuMillicores: number | null;
  memoryBytes: number | null;
  /** Processes and threads, which a fork bomb exhausts without touching either. */
  pids: number | null;
  /** When the reading was taken, which is not when it was asked for. */
  at: Date;
}

/**
 * What the execution plane says about a workload, independent of what the
 * database believes.
 *
 * Deliberately coarser than the runtime status. The provider reports what it
 * observes; deciding what that means for the runtime's lifecycle is the
 * control plane's job.
 */
export type ProviderState = 'absent' | 'created' | 'running' | 'exited';

/**
 * A workload the execution plane is holding, as found by looking rather than
 * by being told.
 *
 * The platform's record of what exists is the database. This is the other
 * side of that: what the machine actually has. The two are supposed to agree
 * and periodically do not — a container created for a row whose transaction
 * then rolled back, a row deleted while its host was unreachable — and nothing
 * could find the difference without being able to enumerate one of them.
 *
 * `workloadId` and `projectId` come from the labels the platform set when it
 * created the container, which is why only containers this platform created
 * appear here at all. Anything else on the machine is somebody else's and is
 * never listed, let alone removed.
 */
export interface ManagedWorkload {
  /** As `ExecutionHandle.externalId`: opaque, and routable back to its host. */
  externalId: string;
  kind: WorkloadKind | 'unknown';
  /** The runtime or deployment row this was created for, if it was labelled. */
  workloadId: string | undefined;
  projectId: string | undefined;
  state: ProviderState;
  /**
   * When the execution plane made it.
   *
   * The single most important field here, because cleanup is not allowed to
   * act on anything young: a container that exists seconds before its row does
   * is an ordinary race, not an orphan.
   */
  createdAt: Date | undefined;
}

/** A per-project network, found the same way and removable the same way. */
export interface ManagedNetwork {
  /** Opaque and routable, like a workload's. Not the name the daemon uses. */
  id: string;
  name: string;
  projectId: string | undefined;
  /** How many containers are still attached. Never remove one that has any. */
  attached: number;
  createdAt: Date | undefined;
}

export interface ExecutionProvider {
  /** Recorded on every runtime, because a handle from one means nothing to another. */
  readonly name: string;

  /**
   * Why this provider cannot be used right now, or null when it can.
   *
   * Asked before anything is written, so an installation with no execution
   * backend refuses honestly instead of recording a runtime that will never
   * exist. The string is shown to a person, so it says what is wrong and not
   * merely that something is.
   */
  unavailableReason(): Promise<string | null>;

  create(request: ProvisionRequest): Promise<ExecutionHandle>;

  /**
   * Places the project's files into the workload, before it starts.
   *
   * Separate from `create` because they fail for different reasons and the
   * difference matters to the person waiting: an image that will not pull is
   * not the same problem as a project too large to copy.
   */
  seedWorkspace(handle: ExecutionHandle, entries: readonly WorkspaceEntry[]): Promise<void>;

  start(handle: ExecutionHandle): Promise<void>;

  /**
   * Asks the workload to stop, then forces it after the grace period.
   *
   * Succeeds if it was already stopped.
   */
  stop(handle: ExecutionHandle, graceSeconds: number): Promise<void>;

  /** Removes the workload. Succeeds if it is already gone. */
  destroy(handle: ExecutionHandle): Promise<void>;

  /** What the execution plane currently observes. */
  inspect(handle: ExecutionHandle): Promise<ProviderState>;

  /**
   * Reads the workload's workspace back.
   *
   * The other half of rule 4. A container is not storage, which is only true
   * if what happens inside one can be brought out: an install, a generator or
   * a build otherwise exists nowhere the platform can see.
   *
   * Returns files only. Directories are implied by the paths, and an empty one
   * left by a tool is not worth carrying.
   */
  readWorkspace(handle: ExecutionHandle): Promise<WorkspaceFile[]>;

  /**
   * What the workload is using right now, or null when it cannot be measured.
   *
   * Null rather than zero, and the distinction is the whole reason this returns
   * what it does: a memory reading of zero and a memory reading that failed look
   * identical on a chart and mean opposite things. A provider that cannot
   * measure says so, and everything above it shows "not measured".
   *
   * Point in time. Keeping a history is the control plane's business, and a
   * provider that kept one would be a second place for it to be wrong.
   */
  stats(handle: ExecutionHandle): Promise<WorkloadStats | null>;

  /**
   * Bytes the workload has written to its own filesystem, or null when that
   * cannot be measured. What a disk limit is enforced against.
   */
  diskUsage(handle: ExecutionHandle): Promise<number | null>;

  /**
   * Reads one directory out of a workload, exactly as it is.
   *
   * Separate from `readWorkspace` because the two want opposite things from the
   * same archive. Reading a workspace back into a project drops the paths a
   * project never wants — `node_modules`, `.git`, `dist` — because they belong
   * in the container. Collecting a build's output wants precisely those: `dist`
   * is on that list and is the whole point of a static build.
   *
   * The path is relative to the workload's workspace. Nothing is filtered, so
   * the ceilings are the only protection and they are a deliberate refusal
   * rather than a truncation: half a site served as a whole one is worse than a
   * build that says it produced too much.
   */
  readDirectory(handle: ExecutionHandle, directory: string): Promise<WorkspaceFile[]>;

  /**
   * Where each of the workload's watched ports can be reached from here.
   *
   * Says nothing about whether anything is listening on them: that is a
   * question for whoever connects.
   */
  publishedPorts(handle: ExecutionHandle): Promise<PublishedPort[]>;

  /**
   * Starts the project's own application inside a running workload.
   *
   * The command comes from the project, which is the one place a caller-named
   * program is correct: it runs inside the container, as the container, and
   * never touches the host. Everything that keeps that true lives below this
   * line.
   *
   * At most one at a time. A second would make "is it running" unanswerable
   * and leave the first with nothing able to stop it.
   */
  startProcess(handle: ExecutionHandle, options: StartProcessOptions): Promise<RunningProcess>;

  /**
   * Stops the application, if one is running.
   *
   * Asks first and forces after the grace period. Succeeds when nothing was
   * running, because that is the state being asked for.
   */
  stopProcess(handle: ExecutionHandle, graceSeconds: number): Promise<void>;

  /**
   * Whether the application is still running.
   *
   * Asked of the workload rather than remembered, so a control plane that
   * restarted can find out what it missed.
   */
  processRunning(handle: ExecutionHandle): Promise<boolean>;

  /**
   * Opens an interactive shell inside a running workload.
   *
   * The command is the provider's own choice, never the caller's. A caller
   * that could name the program would be one step from naming a program on
   * the host, and this interface is the boundary that has to hold.
   */
  openTerminal(handle: ExecutionHandle, options: TerminalOptions): Promise<TerminalSession>;

  /**
   * Starts a shell that belongs to the workload rather than to the connection.
   *
   * The difference from `openTerminal` is what happens when the control plane
   * goes away: an ordinary terminal is a stream this process holds, so a restart
   * takes the shell with it, and a build or a watch process is lost to a deploy
   * of the platform. One started here is a process inside the container, and the
   * platform reattaches to it afterwards.
   *
   * Identified by a name the caller generates, not by a handle: there is nothing
   * to hold, which is the point. Everything about the session is derivable
   * inside the container from that name.
   *
   * May refuse, and a caller must be ready for it: the mechanism needs a couple
   * of ordinary tools present in the image, and an image without them is a real
   * possibility rather than a broken installation.
   */
  startTerminal(
    handle: ExecutionHandle,
    terminalId: string,
    options: TerminalOptions,
  ): Promise<void>;

  /** Attaches to one already running. Detaching leaves it running. */
  attachTerminal(handle: ExecutionHandle, terminalId: string): Promise<TerminalSession>;

  /** Ends one and removes what it left behind. */
  stopTerminal(handle: ExecutionHandle, terminalId: string): Promise<void>;

  /** Whether a shell started this way is still there. */
  terminalRunning(handle: ExecutionHandle, terminalId: string): Promise<boolean>;

  /**
   * Everything this platform has created and not removed.
   *
   * The enumeration cleanup needs, and the reason it is on the port rather than
   * reached for directly: a platform spread over several machines has to ask all
   * of them, and the caller must not learn that there is more than one.
   *
   * Scoped by label to what this platform made. A cleanup routine that listed
   * every container on a machine would eventually meet one that belonged to
   * somebody else, and the consequence of getting that wrong is not recoverable.
   */
  listWorkloads(): Promise<ManagedWorkload[]>;

  /** The per-project networks, for the same reason and with the same scoping. */
  listNetworks(): Promise<ManagedNetwork[]>;

  /**
   * Removes one network, by the identifier `listNetworks` gave.
   *
   * Removing one that is already gone is success: two sweeps overlapping, or a
   * project deleted between the listing and the removal, are both ordinary.
   */
  removeNetwork(id: string): Promise<void>;
}
