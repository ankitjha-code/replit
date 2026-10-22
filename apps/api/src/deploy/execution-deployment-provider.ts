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

export interface ExecutionDeploymentOptions {
  buildTimeoutMs: number;
  readyTimeoutMs: number;
  probeTimeoutMs: number;
  stopGraceSeconds: number;
}

export class ExecutionDeploymentProvider implements DeploymentProvider {
  readonly name = 'execution';

  constructor(
    private readonly execution: ExecutionProvider,
    private readonly options: ExecutionDeploymentOptions,
    private readonly log: Logger,
  ) {}

  unavailableReason(): Promise<string | null> {
    return this.execution.unavailableReason();
  }

  async build(spec: BuildSpec): Promise<BuildHandle> {
    const handle = await this.execution.create({
      workloadId: spec.deploymentId,
      kind: 'deployment',
      projectId: spec.projectId,
      image: spec.image,
      limits: spec.limits,
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
      await this.execution.destroy(handle).catch(() => undefined);
      throw error;
    }

    return { externalId: handle.externalId, ...(handle.host ? { host: handle.host } : {}) };
  }

  collect(handle: BuildHandle, outputDirectory: string): Promise<BuildResult> {
    return this.execution
      .readDirectory({ externalId: handle.externalId }, outputDirectory)
      .then((files) => ({ files }));
  }

  async serve(handle: BuildHandle, spec: ServeSpec): Promise<DeploymentHandle> {
    const workload = { externalId: handle.externalId };

    const process = await this.execution.startProcess(workload, {
      command: spec.startCommand,
      env: spec.environment,
    });

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

  async target(handle: {
    externalId: string;
    containerPort: number;
  }): Promise<DeploymentTarget | null> {
    const published = await this.execution.publishedPorts({ externalId: handle.externalId });
    const match = published.find((entry) => entry.containerPort === handle.containerPort);

    if (!match) return null;
    return { host: match.host, port: match.port, containerPort: match.containerPort };
  }

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

  private async awaitPort(
    handle: { externalId: string },
    hasExited: () => boolean,
  ): Promise<number | null> {
    const deadline = Date.now() + this.options.readyTimeoutMs;

    while (Date.now() < deadline) {
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

export function entriesOf(
  files: readonly { path: string; content: Uint8Array | null }[],
): WorkspaceEntry[] {
  return files.map((file) => ({ path: file.path, content: file.content }));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
