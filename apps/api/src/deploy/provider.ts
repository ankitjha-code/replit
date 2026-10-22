import type { ResourceLimits } from '@platform/shared';
import type { WorkspaceEntry, WorkspaceFile } from '../execution/provider.js';

export interface BuildSpec {
  deploymentId: string;
  projectId: string;

  image: string;

  entries: readonly WorkspaceEntry[];

  buildCommand: string | null;

  outputDirectory: string | null;

  environment: Readonly<Record<string, string>>;

  limits: ResourceLimits;

  onLog: (chunk: string) => void;
}

export interface BuildHandle {
  externalId: string;
  host?: string;
}

export interface BuildResult {
  files: WorkspaceFile[];
}

export interface ServeSpec {
  deploymentId: string;
  startCommand: string;
  environment: Readonly<Record<string, string>>;

  onOutput?: (output: { stream: 'stdout' | 'stderr'; chunk: string }) => void;

  onExit?: (code: number | null) => void;
}

export interface DeploymentHandle {
  externalId: string;
  containerPort: number;
}

export interface DeploymentTarget {
  host: string;
  port: number;
  containerPort: number;
}

export interface DeploymentProvider {
  readonly name: string;

  unavailableReason(): Promise<string | null>;

  build(spec: BuildSpec): Promise<BuildHandle>;

  collect(handle: BuildHandle, outputDirectory: string): Promise<BuildResult>;

  serve(handle: BuildHandle, spec: ServeSpec): Promise<DeploymentHandle>;

  target(handle: { externalId: string; containerPort: number }): Promise<DeploymentTarget | null>;

  stop(handle: { externalId: string }): Promise<void>;

  destroy(handle: { externalId: string }): Promise<void>;

  diskUsage(handle: { externalId: string }): Promise<number | null>;
}
