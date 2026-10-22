import {
  DEPLOYMENT_TARGET_LABELS,
  type DeploymentStatus,
  type DeploymentSummary,
} from '@platform/shared';
import type { Tone } from '../../ui/index.js';

/**
 * The words the Deploy page uses for a deployment, shared by the list, the
 * build output dialog and the Activity rows so one release is never called
 * two things.
 */

/**
 * The last characters of the id: enough to tell deployments apart in a list
 * of twenty. The last, not the first, because the ids are time-ordered and
 * deployments made in the same hour share their opening characters.
 */
export function shortId(id: string): string {
  return id.slice(-6);
}

/** "deployment 3f9a1c": the object every row action is named after. */
export function deploymentObjectName(deployment: Pick<DeploymentSummary, 'id'>): string {
  return `deployment ${shortId(deployment.id)}`;
}

/** The row's title: the note when one was given, else what was deployed. */
export function deploymentTitle(deployment: Pick<DeploymentSummary, 'note' | 'target'>): string {
  return deployment.note ?? DEPLOYMENT_TARGET_LABELS[deployment.target];
}

export interface StatusWords {
  word: string;
  tone: Tone;
  /** Something is happening right now: shown with a spinner. */
  busy: boolean;
}

export function describeStatus(status: DeploymentStatus): StatusWords {
  switch (status) {
    case 'REQUESTED':
      return { word: 'Queued', tone: 'info', busy: true };
    case 'BUILDING':
      return { word: 'Building', tone: 'info', busy: true };
    case 'STARTING':
      return { word: 'Starting', tone: 'info', busy: true };
    case 'RUNNING':
      return { word: 'Running', tone: 'ok', busy: false };
    case 'STOPPING':
      return { word: 'Stopping', tone: 'warn', busy: true };
    case 'STOPPED':
      return { word: 'Stopped', tone: 'neutral', busy: false };
    case 'FAILED':
      return { word: 'Failed', tone: 'danger', busy: false };
  }
}

/** True while the platform is still working on it, which is when the list polls. */
export function isSettling(deployment: Pick<DeploymentSummary, 'status'>): boolean {
  return describeStatus(deployment.status).busy;
}

/** True while a build is queued, building or starting: the row shows its progress. */
export function isBuilding(deployment: Pick<DeploymentSummary, 'status'>): boolean {
  return (
    deployment.status === 'REQUESTED' ||
    deployment.status === 'BUILDING' ||
    deployment.status === 'STARTING'
  );
}

/**
 * Whether there is anything to go back to in this release.
 *
 * A release that never finished building produced nothing, so making it live
 * again would mean building code that already failed to build. A static one
 * is identified by having produced files and a server one by having been
 * frozen at all: the same test the server applies, so the action is not
 * offered for something the server would refuse.
 */
export function canRollBackTo(deployment: DeploymentSummary): boolean {
  if (deployment.status === 'RUNNING') return false;
  if (isBuilding(deployment) || deployment.status === 'STOPPING') return false;
  if (deployment.target === 'STATIC') return deployment.fileCount !== null;
  return deployment.snapshotId !== null;
}
