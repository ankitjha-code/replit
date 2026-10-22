import { AppError } from '../errors/app-error.js';
import type {
  BuildHandle,
  BuildResult,
  BuildSpec,
  DeploymentHandle,
  DeploymentProvider,
  DeploymentTarget,
  ServeSpec,
} from './provider.js';

export class UnavailableDeploymentProvider implements DeploymentProvider {
  readonly name = 'none';

  private readonly reason =
    'This installation cannot deploy projects: no deployment backend is configured.';

  unavailableReason(): Promise<string | null> {
    return Promise.resolve(this.reason);
  }

  build(_spec: BuildSpec): Promise<BuildHandle> {
    return Promise.reject(this.refusal());
  }

  collect(_handle: BuildHandle, _outputDirectory: string): Promise<BuildResult> {
    return Promise.reject(this.refusal());
  }

  serve(_handle: BuildHandle, _spec: ServeSpec): Promise<DeploymentHandle> {
    return Promise.reject(this.refusal());
  }

  target(): Promise<DeploymentTarget | null> {
    return Promise.resolve(null);
  }

  stop(): Promise<void> {
    return Promise.resolve();
  }

  destroy(): Promise<void> {
    return Promise.resolve();
  }

  diskUsage(): Promise<number | null> {
    return Promise.resolve(null);
  }

  private refusal(): AppError {
    return new AppError('SERVICE_UNAVAILABLE', this.reason, { expose: true });
  }
}
