import type {
  BuildHandle,
  BuildResult,
  BuildSpec,
  DeploymentHandle,
  DeploymentProvider,
  DeploymentTarget,
  ServeSpec,
} from '../../src/deploy/provider.js';
import type { WorkspaceFile } from '../../src/execution/provider.js';

export class FakeDeploymentProvider implements DeploymentProvider {
  readonly name = 'fake';

  builds: BuildSpec[] = [];
  served: ServeSpec[] = [];
  destroyed: string[] = [];
  stopped: string[] = [];

  failBuild: string | null = null;
  output: WorkspaceFile[] = [
    { path: 'index.html', content: new TextEncoder().encode('<h1>static v1</h1>') },
  ];
  upstream: { host: string; port: number } | null = null;

  private readonly exits = new Map<string, (code: number | null) => void>();
  private sequence = 0;

  unavailableReason(): Promise<string | null> {
    return Promise.resolve(null);
  }

  hold: Promise<void> | null = null;

  build(spec: BuildSpec): Promise<BuildHandle> {
    this.builds.push(spec);
    spec.onLog(`building ${spec.deploymentId}\n`);

    const finish = (): Promise<BuildHandle> => {
      if (this.failBuild) {
        spec.onLog(`${this.failBuild}\n`);
        return Promise.reject(new Error(this.failBuild));
      }
      this.sequence += 1;
      return Promise.resolve({ externalId: `workload-${String(this.sequence)}` });
    };

    return this.hold ? this.hold.then(finish) : finish();
  }

  collect(_handle: BuildHandle, _outputDirectory: string): Promise<BuildResult> {
    return Promise.resolve({ files: this.output });
  }

  serve(handle: BuildHandle, spec: ServeSpec): Promise<DeploymentHandle> {
    this.served.push(spec);
    if (spec.onExit) this.exits.set(handle.externalId, spec.onExit);
    spec.onOutput?.({ stream: 'stdout', chunk: 'listening\n' });
    return Promise.resolve({ externalId: handle.externalId, containerPort: 3000 });
  }

  target(handle: { externalId: string; containerPort: number }): Promise<DeploymentTarget | null> {
    if (!this.upstream || this.destroyed.includes(handle.externalId)) return Promise.resolve(null);
    return Promise.resolve({ ...this.upstream, containerPort: handle.containerPort });
  }

  stop(handle: { externalId: string }): Promise<void> {
    this.stopped.push(handle.externalId);
    return Promise.resolve();
  }

  destroy(handle: { externalId: string }): Promise<void> {
    this.destroyed.push(handle.externalId);
    return Promise.resolve();
  }

  disk = new Map<string, number>();

  diskUsage(handle: { externalId: string }): Promise<number | null> {
    return Promise.resolve(this.disk.get(handle.externalId) ?? null);
  }

  exit(externalId: string, code: number | null): void {
    this.exits.get(externalId)?.(code);
  }
}
