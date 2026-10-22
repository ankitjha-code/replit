import {
  DEPLOYMENT_TARGET_LABELS,
  type DeploymentStatus,
  type DeploymentSummary,
} from '@platform/shared';
import type { Tone } from '../../ui/index.js';

export function shortId(id: string): string {
  return id.slice(-6);
}

export function deploymentObjectName(deployment: Pick<DeploymentSummary, 'id'>): string {
  return `deployment ${shortId(deployment.id)}`;
}

export function deploymentTitle(deployment: Pick<DeploymentSummary, 'note' | 'target'>): string {
  return deployment.note ?? DEPLOYMENT_TARGET_LABELS[deployment.target];
}

export interface StatusWords {
  word: string;
  tone: Tone;
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

export function isSettling(deployment: Pick<DeploymentSummary, 'status'>): boolean {
  return describeStatus(deployment.status).busy;
}

export function isBuilding(deployment: Pick<DeploymentSummary, 'status'>): boolean {
  return (
    deployment.status === 'REQUESTED' ||
    deployment.status === 'BUILDING' ||
    deployment.status === 'STARTING'
  );
}

export function canRollBackTo(deployment: DeploymentSummary): boolean {
  if (deployment.status === 'RUNNING') return false;
  if (isBuilding(deployment) || deployment.status === 'STOPPING') return false;
  if (deployment.target === 'STATIC') return deployment.fileCount !== null;
  return deployment.snapshotId !== null;
}
