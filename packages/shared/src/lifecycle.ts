export const RUNTIME_STATUSES = [
  'REQUESTED',
  'CREATING',
  'STARTING',
  'RUNNING',
  'STOPPING',
  'STOPPED',
  'FAILED',
] as const;

export type RuntimeStatus = (typeof RUNTIME_STATUSES)[number];

export const RUNTIME_TRANSITIONS: Readonly<Record<RuntimeStatus, readonly RuntimeStatus[]>> = {
  REQUESTED: ['CREATING', 'FAILED'],
  CREATING: ['STARTING', 'FAILED'],
  STARTING: ['RUNNING', 'FAILED'],
  RUNNING: ['STOPPING', 'STOPPED', 'FAILED'],
  STOPPING: ['STOPPED', 'FAILED'],
  STOPPED: ['REQUESTED'],
  FAILED: ['REQUESTED'],
};

export const DEPLOYMENT_STATUSES = [
  'REQUESTED',
  'BUILDING',
  'STARTING',
  'RUNNING',
  'STOPPING',
  'STOPPED',
  'FAILED',
] as const;

export type DeploymentStatus = (typeof DEPLOYMENT_STATUSES)[number];

export const DEPLOYMENT_TRANSITIONS: Readonly<
  Record<DeploymentStatus, readonly DeploymentStatus[]>
> = {
  REQUESTED: ['BUILDING', 'FAILED'],
  BUILDING: ['STARTING', 'FAILED'],
  STARTING: ['RUNNING', 'FAILED'],
  RUNNING: ['STOPPING', 'STOPPED', 'FAILED'],
  STOPPING: ['STOPPED', 'FAILED'],
  STOPPED: ['REQUESTED'],
  FAILED: ['REQUESTED'],
};

export function canTransition<S extends string>(
  table: Readonly<Record<S, readonly S[]>>,
  from: S,
  to: S,
): boolean {
  return (table[from] ?? []).includes(to);
}

export function isTerminal<S extends string>(
  table: Readonly<Record<S, readonly S[]>>,
  state: S,
  restartTrigger: S,
): boolean {
  const next = table[state] ?? [];
  return next.length === 0 || (next.length === 1 && next[0] === restartTrigger);
}
