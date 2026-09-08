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

/**
 * Previews: seeing what a project serves.
 *
 * Two things live here. Working out where a project's application is, which is
 * a question about ports, and deciding who may look at it, which is a question
 * about people. The forwarding itself is transport and lives with the preview
 * server.
 */

export interface PreviewServiceOptions {
  /** The hostname suffix previews are served under, including the port. */
  hostSuffix: string;
  /** `http` locally, `https` behind a certificate. */
  scheme: 'http' | 'https';
  /** How long a grant may be exchanged for a cookie. */
  grantTtlSeconds: number;
  /** How long a viewing cookie lasts before the browser must ask again. */
  sessionTtlSeconds: number;
  /** How long to wait for a port to accept a connection while probing. */
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

  /** The public address of a project's preview, whether or not it works yet. */
  url(projectId: string): string {
    return `${this.options.scheme}://${previewHost(projectId, this.options.hostSuffix)}/`;
  }

  /**
   * What there is to preview, and why there is not.
   *
   * Never claims an application is there without having connected to it. A
   * link to a page that does not load is worse than being told nothing is
   * listening yet.
   */
  async describe(projectId: string): Promise<PreviewState> {
    const candidatePorts = [...PREVIEW_CANDIDATE_PORTS];
    // Only over HTTPS can the viewing cookie be marked SameSite=None, which is
    // what a browser requires before it will send one into a frame from
    // another site.
    const framable = this.options.scheme === 'https';
    const record = await this.runtimes.findByProject(projectId);

    if (!record || record.status !== 'RUNNING' || !record.externalId) {
      return {
        url: null,
        port: null,
        reason: 'Start the project to see a preview of it.',
        candidatePorts,
        framable,
      };
    }

    const target = await this.findTarget(record.id, record.externalId, record.previewPort);

    if (!target) {
      return {
        url: null,
        port: null,
        /*
         * Why there is nothing, in the terms the person can act on.
         *
         * "Nothing is listening" is true in every one of these cases and
         * useless in most of them: what to do about it depends entirely on
         * whether the application was never started, has crashed, or is simply
         * not serving anything.
         */
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

  /**
   * Where to forward a preview request, or nothing.
   *
   * Called on every request the proxy handles, so the remembered port is tried
   * first and a full probe only happens when that fails.
   */
  async target(projectId: string): Promise<PreviewTarget | undefined> {
    const record = await this.runtimes.findByProject(projectId);
    if (!record || record.status !== 'RUNNING' || !record.externalId) return undefined;
    return this.findTarget(record.id, record.externalId, record.previewPort);
  }

  /**
   * Issues one browser permission to view one project.
   *
   * The token is returned once and never stored: what is kept is its hash, so
   * a dump of the table cannot be replayed. Short lived, because it is
   * exchanged for a cookie within seconds of being issued and a longer life
   * only widens the window for a leaked address.
   */
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

  /**
   * Redeems a grant, once.
   *
   * Deleted as it is used, so an address that leaks after the fact opens
   * nothing. What the browser keeps afterwards is a cookie on the preview
   * host, which is scoped to that host and goes nowhere else.
   */
  async redeemGrant(
    token: string,
  ): Promise<{ projectId: string; userId: string | null; shareId: string | null } | undefined> {
    const record = await this.grants.findByTokenHash(hashToken(token));
    if (!record) return undefined;

    await this.grants.deleteById(record.id);

    if (record.expiresAt.getTime() <= Date.now()) return undefined;
    return { projectId: record.projectId, userId: record.userId, shareId: record.shareId };
  }

  /**
   * Makes a link anybody can open to see this project's preview.
   *
   * The token is returned once, and only its hash is kept — like every other
   * token here. Bounded in time always: a link that never expired would be a
   * deployment by another name, without any of a deployment's care.
   */
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

  /**
   * Turns a share link into a viewing, for somebody with no account.
   *
   * The viewing is tied to the share, so revoking the link later ends it too.
   */
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
      // Never outlives the link it came from.
      expiresAt: new Date(Math.min(Date.now() + ttlSeconds * 1000, share.expiresAt.getTime())),
    });

    return { projectId: share.projectId, viewingToken };
  }

  /**
   * Reads a viewing cookie without spending it.
   *
   * The grant a browser redeems is consumed; what it gets back is a longer
   * lived one that it presents on every request. This is the check for that
   * one, so it deliberately does not delete.
   */
  async resolveViewing(
    token: string,
  ): Promise<{ projectId: string; userId: string | null } | undefined> {
    const record = await this.grants.findByTokenHash(hashToken(token));
    if (!record || record.expiresAt.getTime() <= Date.now()) return undefined;

    /*
     * A viewing from a share is re-checked against the share, every request.
     *
     * Revoking a link deletes the viewings it granted too, but this is the
     * belt to that pair of braces: a link that has been revoked or has expired
     * must not keep anybody looking, whatever the viewing's own expiry says.
     */
    if (record.shareId) {
      const share = await this.grants.findShare(record.shareId);
      if (!share || share.revokedAt || share.expiresAt.getTime() <= Date.now()) return undefined;
    }

    return { projectId: record.projectId, userId: record.userId };
  }

  /** Drops grants nobody can use. */
  async purgeExpiredGrants(): Promise<number> {
    const { count } = await this.grants.deleteExpired(new Date());
    return count;
  }

  // -------------------------------------------------------------------------

  /**
   * Finds the port an application is listening on.
   *
   * The remembered one first, then the watched list in order.
   *
   * The test is a real HTTP request, not a connect. A container runtime
   * publishes a port by binding it on the host, and that binding accepts
   * connections whether or not anything inside is listening: a connect
   * succeeds against an empty container and would have the platform claim a
   * preview that does not exist.
   */
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
          // Remembered so the next request tries the right one first. A failure
          // to record it costs a probe, not a preview.
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

/**
 * Why nothing is being served, given what the application is doing.
 *
 * The runtime is up in every branch here: what differs is the program inside
 * it, and that difference is the whole answer.
 */
function notListeningReason(runStatus: RunStatus, exitCode: number | null): string {
  switch (runStatus) {
    case 'IDLE':
      return 'The project is running but its application has not been started. Press Run, or start a server in the terminal.';
    case 'STARTING':
      return 'The application is starting.';
    case 'RUNNING':
      return 'The application is running but nothing is listening on the ports the platform watches yet.';
    case 'FAILED':
      return exitCode === null
        ? 'The application stopped before it served anything. Check the output.'
        : `The application exited with code ${exitCode}. Check the output.`;
    case 'EXITED':
      return 'The application is not running. Press Run to start it again.';
  }
}

/** Thrown when a preview is asked for on an installation that cannot serve one. */
export function previewUnavailable(reason: string): AppError {
  return new AppError('SERVICE_UNAVAILABLE', reason, { expose: true });
}
