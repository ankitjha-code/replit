import {
  PREVIEW_SHARE_PARAM,
  PREVIEW_CANDIDATE_PORTS,
  previewHost,
  type PreviewState,
  type RunStatus,
} from '@platform/shared';
import type { Logger } from 'pino';
import { AppError } from '../../errors/app-error.js';
import type { ExecutionProvider } from '../../execution/provider.js';
import { generateSessionToken, hashToken } from '../../lib/tokens.js';
import { isServingHttp } from '../../lib/probes/http.js';
import type { RuntimeRepository } from '../runtimes/runtime.repository.js';
import type { PreviewGrantRepository, PreviewShareRecord } from './preview.repository.js';

export interface PreviewServiceOptions {
  hostSuffix: string;
  scheme: 'http' | 'https';
  grantTtlSeconds: number;
  sessionTtlSeconds: number;
  probeTimeoutMs: number;
}

export interface PreviewTarget {
  host: string;
  port: number;
  containerPort: number;
}

export class PreviewService {
  constructor(
    private readonly runtimes: RuntimeRepository,
    private readonly grants: PreviewGrantRepository,
    private readonly provider: ExecutionProvider,
    private readonly options: PreviewServiceOptions,
    private readonly log: Logger,
  ) {}

  url(projectId: string): string {
    return `${this.options.scheme}://${previewHost(projectId, this.options.hostSuffix)}/`;
  }

  async describe(projectId: string): Promise<PreviewState> {
    const candidatePorts = [...PREVIEW_CANDIDATE_PORTS];
    const framable = this.options.scheme === 'https';
    const record = await this.runtimes.findByProject(projectId);

    if (!record || record.status !== 'RUNNING' || !record.externalId) {
      return {
        url: null,
        port: null,
        reason:
          'Start the environment, then run the app. The preview appears when it listens on a port.',
        candidatePorts,
        framable,
      };
    }

    const target = await this.findTarget(record.id, record.externalId, record.previewPort);

    if (!target) {
      return {
        url: null,
        port: null,
        reason: notListeningReason(record.runStatus, record.runExitCode),
        candidatePorts,
        framable,
      };
    }

    return {
      url: this.url(projectId),
      port: target.containerPort,
      reason: null,
      candidatePorts,
      framable,
    };
  }

  async target(projectId: string): Promise<PreviewTarget | undefined> {
    const record = await this.runtimes.findByProject(projectId);
    if (!record || record.status !== 'RUNNING' || !record.externalId) return undefined;
    return this.findTarget(record.id, record.externalId, record.previewPort);
  }

  async issueGrant(
    projectId: string,
    userId: string | null,
    ttlSeconds = this.options.grantTtlSeconds,
  ): Promise<{ token: string; url: string }> {
    const token = generateSessionToken();
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

    await this.grants.create({ projectId, userId, tokenHash: hashToken(token), expiresAt });

    return { token, url: this.url(projectId) };
  }

  async redeemGrant(
    token: string,
  ): Promise<{ projectId: string; userId: string | null; shareId: string | null } | undefined> {
    const record = await this.grants.findByTokenHash(hashToken(token));
    if (!record) return undefined;

    await this.grants.deleteById(record.id);

    if (record.expiresAt.getTime() <= Date.now()) return undefined;
    return { projectId: record.projectId, userId: record.userId, shareId: record.shareId };
  }

  async createShare(
    projectId: string,
    userId: string,
    input: { hours: number; label?: string | undefined },
  ): Promise<{ share: PreviewShareRecord; url: string }> {
    const token = generateSessionToken();
    const share = await this.grants.createShare({
      projectId,
      createdById: userId,
      tokenHash: hashToken(token),
      label: input.label?.trim() ? input.label.trim() : null,
      expiresAt: new Date(Date.now() + input.hours * 60 * 60_000),
    });

    return {
      share,
      url: `${this.url(projectId)}/?${PREVIEW_SHARE_PARAM}=${encodeURIComponent(token)}`,
    };
  }

  listShares(projectId: string): Promise<PreviewShareRecord[]> {
    return this.grants.listShares(projectId);
  }

  async revokeShare(projectId: string, shareId: string): Promise<void> {
    if (!(await this.grants.revokeShare(projectId, shareId))) {
      throw new AppError('NOT_FOUND', 'There is no active share link with that identifier', {
        expose: true,
      });
    }
  }

  async redeemShare(
    token: string,
    ttlSeconds: number,
  ): Promise<{ projectId: string; viewingToken: string } | undefined> {
    const share = await this.grants.findShareByTokenHash(hashToken(token));
    if (!share || share.revokedAt || share.expiresAt.getTime() <= Date.now()) return undefined;

    const viewingToken = generateSessionToken();
    await this.grants.create({
      projectId: share.projectId,
      userId: null,
      shareId: share.id,
      tokenHash: hashToken(viewingToken),
      expiresAt: new Date(Math.min(Date.now() + ttlSeconds * 1000, share.expiresAt.getTime())),
    });

    return { projectId: share.projectId, viewingToken };
  }

  async resolveViewing(
    token: string,
  ): Promise<{ projectId: string; userId: string | null } | undefined> {
    const record = await this.grants.findByTokenHash(hashToken(token));
    if (!record || record.expiresAt.getTime() <= Date.now()) return undefined;

    if (record.shareId) {
      const share = await this.grants.findShare(record.shareId);
      if (!share || share.revokedAt || share.expiresAt.getTime() <= Date.now()) return undefined;
    }

    return { projectId: record.projectId, userId: record.userId };
  }

  async purgeExpiredGrants(): Promise<number> {
    const { count } = await this.grants.deleteExpired(new Date());
    return count;
  }

  private async findTarget(
    runtimeId: string,
    externalId: string,
    remembered: number | null,
  ): Promise<PreviewTarget | undefined> {
    let published;
    try {
      published = await this.provider.publishedPorts({ externalId });
    } catch (error) {
      this.log.warn({ err: error, runtimeId }, 'could not read published ports');
      return undefined;
    }

    if (published.length === 0) return undefined;

    const byContainerPort = new Map(published.map((entry) => [entry.containerPort, entry]));

    const order = remembered
      ? [remembered, ...PREVIEW_CANDIDATE_PORTS.filter((port) => port !== remembered)]
      : [...PREVIEW_CANDIDATE_PORTS];

    for (const containerPort of order) {
      const entry = byContainerPort.get(containerPort);
      if (!entry) continue;

      if (await isServingHttp(entry.host, entry.port, this.options.probeTimeoutMs)) {
        if (remembered !== containerPort) {
          await this.runtimes
            .setPreviewPort(runtimeId, containerPort)
            .catch((error: unknown) =>
              this.log.warn({ err: error, runtimeId }, 'could not record the preview port'),
            );
        }
        return { host: entry.host, port: entry.port, containerPort };
      }
    }

    return undefined;
  }
}

function notListeningReason(runStatus: RunStatus, exitCode: number | null): string {
  switch (runStatus) {
    case 'IDLE':
      return 'The environment is running but its application has not been started. Press Run, or start a server in the Shell.';
    case 'STARTING':
      return 'The app is starting. The preview appears when it listens on a port.';
    case 'RUNNING':
      return 'The app is running but nothing is listening on a port the preview watches yet.';
    case 'FAILED':
      return exitCode === null
        ? 'The app stopped before it served anything. Its output says why.'
        : `The app exited with code ${exitCode}. Its output says why.`;
    case 'EXITED':
      return 'The app is not running. Press Run to start it again.';
  }
}

export function previewUnavailable(reason: string): AppError {
  return new AppError('SERVICE_UNAVAILABLE', reason, { expose: true });
}
