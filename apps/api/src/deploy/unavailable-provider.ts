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

/**
 * The provider an installation gets when nothing can build or serve.
 *
 * Not a stub that pretends. It says why and refuses, so the page reads "this
 * installation cannot deploy projects" rather than showing a deployment that
 * does not exist.
 *
 * The asymmetry below is the same one the unavailable database provider has:
 * anything that makes something refuses, and anything that cleans up succeeds.
 * Cleanup must never be blocked by there being nothing to clean up.
 */
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

  /** Null rather than a refusal: nothing is running, which is an answer. */
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
