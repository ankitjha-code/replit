import { PREVIEW_CANDIDATE_PORTS } from '@platform/shared';
import type { Logger } from 'pino';
import { AppError } from '../errors/app-error.js';
import type { ExecutionProvider, WorkspaceEntry } from '../execution/provider.js';
import { isServingHttp } from '../lib/probes/http.js';
import type {
  BuildHandle,
  BuildResult,
  BuildSpec,
  DeploymentHandle,
  DeploymentProvider,
  DeploymentTarget,
  ServeSpec,
} from './provider.js';

/**
 * Builds and serves deployments using the platform's own execution plane.
 *
 * There is no second container stack here and no image registry. A build is a
 * command run against a project's files, which is exactly what the execution
 * provider already does safely: no mounts, every capability dropped, its own
 * network, and hard ceilings on processor, memory and process count. Adding a
 * second way to run untrusted code would mean a second set of those decisions
 * to get right.
 *
 * Two shapes, because the targets genuinely differ:
 *
 * - **A static site** is built in a container that is then thrown away. What
 *   survives is the contents of its output directory, which the platform stores
 *   and serves itself. Nothing runs afterwards, so a static deployment keeps
 *   working while the execution backend is down or restarting.
 * - **A server** is built and run in the *same* container, and that is not a
 *   shortcut. Its dependencies are installed into that filesystem, and moving a
 *   built tree between containers would mean carrying `node_modules` through
 *   the control plane's memory — hundreds of megabytes and a hundred thousand
 *   files, for no gain over leaving them where they were installed.
 *
 * The application inside a server deployment runs as an exec rather than as the
 * container's own command, following the runtime: the container has to stay up
 * when the program dies, because that is exactly when somebody needs its log.
 */

export interface ExecutionDeploymentOptions {
  /** How long a build may run before it is abandoned. */
  buildTimeoutMs: number;
  /** How long to wait for a started server to answer on a port. */
  readyTimeoutMs: number;
  /** How long one probe waits, while looking for the port. */
  probeTimeoutMs: number;
  /** How long to let a deployment's process finish before it is forced. */
  stopGraceSeconds: number;
}

export class ExecutionDeploymentProvider implements DeploymentProvider {
  readonly name = 'execution';

  constructor(
    private readonly execution: ExecutionProvider,
    private readonly options: ExecutionDeploymentOptions,
    private readonly log: Logger,
  ) {}

  /**
   * Why nothing can be deployed, or null when it can.
   *
   * Delegated rather than answered here: this provider can do exactly what the
   * execution plane can do, so an installation with no container backend cannot
   * deploy and should say the same thing in both places.
   */
  unavailableReason(): Promise<string | null> {
    return this.execution.unavailableReason();
  }

  /**
   * Creates the workload, puts the project in it, and runs the build.
   *
   * The container is left running afterwards. For a static target the caller
   * takes the output and destroys it; for a server the same container goes on
   * to run the application, with its dependencies already installed where they
   * were installed.
   *
   * A project with no build command still gets a container: a server needs one
   * to run in, and a static site with nothing to build still has to have its
   * files collected from somewhere.
   */
  async build(spec: BuildSpec): Promise<BuildHandle> {
    const handle = await this.execution.create({
      workloadId: spec.deploymentId,
      kind: 'deployment',
      projectId: spec.projectId,
      image: spec.image,
      limits: spec.limits,
      /*
       * No command, so the container idles.
       *
       * The build and, for a server, the application both run as execs inside
       * it. A container whose command is the build would end when the build
       * ended, taking with it the filesystem the build just produced.
       */
      env: spec.environment,
    });

    try {
      await this.execution.seedWorkspace(handle, spec.entries);
      await this.execution.start(handle);

      if (spec.buildCommand) {
        await this.run(handle, spec.buildCommand, spec.environment, spec.onLog);
      } else {
        spec.onLog('No build command, so nothing was built.\n');
      }
    } catch (error) {
      // The container is this provider's to clean up: the caller has no handle
      // for it yet and would have no way to.
      await this.execution.destroy(handle).catch(() => undefined);
      throw error;
    }

    /*
     * The host the workload was placed on travels with the handle.
     *
     * A deployment records it for the same reason a runtime does: the scheduler
     * counts what is placed on each machine, and counting by parsing an opaque
     * identifier would make that encoding something everything depended on.
     */
    return { externalId: handle.externalId, ...(handle.host ? { host: handle.host } : {}) };
  }

  /** Takes a static build's output out of the workload it was built in. */
  collect(handle: BuildHandle, outputDirectory: string): Promise<BuildResult> {
    return this.execution
      .readDirectory({ externalId: handle.externalId }, outputDirectory)
      .then((files) => ({ files }));
  }

  /**
   * Starts the application and waits until something actually answers.
   *
   * Resolving means a port responded to a real HTTP request, not that a process
   * was spawned. The execution plane already refuses to report a runtime
   * running on weaker evidence than that, and a deployment shown as live in
   * front of a blank page is worse: nobody is watching it.
   */
  async serve(handle: BuildHandle, spec: ServeSpec): Promise<DeploymentHandle> {
    const workload = { externalId: handle.externalId };

    const process = await this.execution.startProcess(workload, {
      command: spec.startCommand,
      env: spec.environment,
    });

    /*
     * The stream is kept, not detached.
     *
     * A deployment outlives the request that started it, and nothing reattaches
     * to one afterwards: no terminal, no poller, no reconciler. Letting go of
     * the stream the moment the site answers would mean the platform never sees
     * another thing the deployment prints and never learns that it stopped.
     *
     * So the caller is handed the output and the exit, and whether they are
     * worth anything is its decision. What this must not do is silently throw
     * them away.
     */
    const decoder = new TextDecoder();

    process.onOutput((output) => {
      spec.onOutput?.({
        stream: output.stream,
        chunk: decoder.decode(output.chunk, { stream: true }),
      });
    });

    let exited: number | null | undefined;
    process.onExit((code) => {
      exited = code;
      spec.onExit?.(code);
    });

    const port = await this.awaitPort(workload, () => exited !== undefined);

    if (port === null) {
      await this.execution
        .stopProcess(workload, this.options.stopGraceSeconds)
        .catch(() => undefined);

      throw new AppError(
        'EXECUTION_FAILED',
        exited === undefined
          ? 'The deployment started but nothing answered on a port, so it was not published.'
          : `The deployment exited immediately with code ${String(exited)}.`,
        { expose: true, context: { deploymentId: spec.deploymentId } },
      );
    }

    return { externalId: handle.externalId, containerPort: port };
  }

  /** Where to reach a running deployment, on this machine only. */
  async target(handle: {
    externalId: string;
    containerPort: number;
  }): Promise<DeploymentTarget | null> {
    const published = await this.execution.publishedPorts({ externalId: handle.externalId });
    const match = published.find((entry) => entry.containerPort === handle.containerPort);

    if (!match) return null;
    return { host: match.host, port: match.port, containerPort: match.containerPort };
  }

  /**
   * Stops the application, leaving the container so its state can be inspected.
   *
   * The workload is removed by `destroy`, which the platform calls when the
   * deployment record goes. Stopping and forgetting are separate because a
   * stopped deployment is still a thing somebody may want to look at.
   */
  async stop(handle: { externalId: string }): Promise<void> {
    await this.execution.stopProcess(handle, this.options.stopGraceSeconds);
    await this.execution.stop(handle, this.options.stopGraceSeconds);
  }

  async destroy(handle: { externalId: string }): Promise<void> {
    await this.execution.destroy(handle);
  }

  diskUsage(handle: { externalId: string }): Promise<number | null> {
    return this.execution.diskUsage(handle);
  }

  // -------------------------------------------------------------------------

  /**
   * Runs one command to completion, streaming what it prints.
   *
   * Bounded in time. A build that never ends holds a container, a row that says
   * BUILDING and somebody's attention, and the only thing that can end it is a
   * clock.
   */
  private run(
    handle: { externalId: string },
    command: string,
    environment: Readonly<Record<string, string>>,
    onLog: (chunk: string) => void,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const finish = (error?: AppError): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };

      void this.execution
        .startProcess(handle, { command, env: environment })
        .then((process) => {
          const decoder = new TextDecoder();

          process.onOutput((output) => {
            // Decoded as it arrives, with streaming turned on so a chunk that
            // splits a character does not become a replacement mark.
            onLog(decoder.decode(output.chunk, { stream: true }));
          });

          process.onExit((code) => {
            if (code === 0) {
              finish();
              return;
            }
            finish(
              new AppError(
                'EXECUTION_FAILED',
                code === null
                  ? 'The build ended and the platform could not learn why. Its output is above.'
                  : `The build failed with exit code ${String(code)}. Its output is above.`,
                { expose: true },
              ),
            );
          });

          timer = setTimeout(() => {
            void this.execution
              .stopProcess(handle, this.options.stopGraceSeconds)
              .catch(() => undefined);

            finish(
              new AppError(
                'EXECUTION_FAILED',
                'The build ran longer than this installation allows and was stopped.',
                { expose: true },
              ),
            );
          }, this.options.buildTimeoutMs);
        })
        .catch((error: unknown) => {
          this.log.error({ err: error }, 'a deployment build could not be started');
          finish(
            new AppError('EXECUTION_FAILED', 'The build could not be started.', { expose: true }),
          );
        });
    });
  }

  /**
   * Finds the port the application is listening on, or gives up.
   *
   * A real HTTP request rather than a TCP connect, for the reason the preview
   * learned the hard way: the container runtime publishes a port by binding it
   * on the host, and that binding accepts connections whether or not anything
   * inside is listening.
   *
   * Polls, because a server takes an unknown amount of time to get up and there
   * is nothing to wait on: the process is running from the first instant and
   * says nothing about when it is ready.
   */
  private async awaitPort(
    handle: { externalId: string },
    hasExited: () => boolean,
  ): Promise<number | null> {
    const deadline = Date.now() + this.options.readyTimeoutMs;

    while (Date.now() < deadline) {
      // A program that has already ended is never going to answer, and waiting
      // out the full timeout for it would turn a fast failure into a slow one.
      if (hasExited()) return null;

      const published = await this.execution.publishedPorts(handle);
      const candidates = published.filter((entry) =>
        (PREVIEW_CANDIDATE_PORTS as readonly number[]).includes(entry.containerPort),
      );

      for (const entry of candidates) {
        if (await isServingHttp(entry.host, entry.port, this.options.probeTimeoutMs)) {
          return entry.containerPort;
        }
      }

      await delay(500);
    }

    return null;
  }
}

/** Workspace entries, in the shape the execution plane wants them. */
export function entriesOf(
  files: readonly { path: string; content: Uint8Array | null }[],
): WorkspaceEntry[] {
  return files.map((file) => ({ path: file.path, content: file.content }));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
