import { randomBytes } from 'node:crypto';
import {
  MAX_SUBDOMAIN_LENGTH,
  RESERVED_SUBDOMAINS,
  customDomainSchema,
  deploymentHostFor,
  deploymentSubdomainSchema,
  verificationRecordName,
  type CustomDomainSummary,
  type DomainStatus,
} from '@platform/shared';
import type { Logger } from 'pino';
import { AppError } from '../../errors/app-error.js';
import type { ProjectEventPublisher } from '../../events/project-event-bus.js';
import { resolveCname, resolveTxt } from '../../lib/probes/dns.js';
import type { DomainRecord, DomainRepository } from './domain.repository.js';

export interface DomainServiceOptions {
  hostSuffix: string;
  scheme: string;
  maxPerProject: number;
  dnsTimeoutMs: number;
  dnsServers: readonly string[];
  customDomainsUnavailableReason: string | null;
  resolver?: {
    txt: typeof resolveTxt;
    cname: typeof resolveCname;
  };
}

export interface DomainRecheckReport {
  checked: number;
  stillPointing: number;
  missed: number;
  lapsed: number;
}

const MAX_SUBDOMAIN_ATTEMPTS = 25;

export class DomainService {
  constructor(
    private readonly domains: DomainRepository,
    private readonly options: DomainServiceOptions,
    private readonly log: Logger,
  ) {}

  private events: ProjectEventPublisher | undefined;

  useEvents(events: ProjectEventPublisher): void {
    this.events = events;
  }

  async ensureSubdomain(projectId: string): Promise<string> {
    const held = await this.domains.subdomainOf(projectId);
    if (held) return held;

    const slug = (await this.domains.slugOf(projectId)) ?? '';
    const base = sanitiseLabel(slug) || 'project';

    for (const candidate of this.candidates(base)) {
      if (RESERVED_SUBDOMAINS.has(candidate)) continue;
      if (await this.domains.subdomainTaken(candidate)) continue;

      const { ok } = await this.domains.setSubdomain(projectId, candidate);
      if (ok) {
        this.log.info({ projectId, subdomain: candidate }, 'deployment subdomain assigned');
        return candidate;
      }
    }

    throw new AppError(
      'CONFLICT',
      'A deployment address could not be assigned to this project. Choose one yourself.',
    );
  }

  async setSubdomain(projectId: string, input: string): Promise<string> {
    const result = deploymentSubdomainSchema.safeParse(input);

    if (!result.success) {
      throw new AppError('VALIDATION_FAILED', 'That address cannot be used', {
        details: {
          fields: [
            { path: 'subdomain', message: result.error.issues[0]?.message ?? 'Invalid name' },
          ],
        },
      });
    }

    const { ok } = await this.domains.setSubdomain(projectId, result.data);

    if (!ok) {
      throw new AppError('CONFLICT', 'That address is already taken', {
        details: { field: 'subdomain' },
      });
    }

    this.log.info({ projectId, subdomain: result.data }, 'deployment subdomain changed');
    this.events?.publish(projectId, { type: 'deployments.changed' });

    return result.data;
  }

  releaseAddress(label: string): string {
    return `${this.options.scheme}://${deploymentHostFor(label, this.options.hostSuffix)}`;
  }

  async addressOf(projectId: string): Promise<{ subdomain: string; url: string } | null> {
    const subdomain = await this.domains.subdomainOf(projectId);
    if (!subdomain) return null;

    return {
      subdomain,
      url: `${this.options.scheme}://${deploymentHostFor(subdomain, this.options.hostSuffix)}`,
    };
  }

  async list(projectId: string): Promise<CustomDomainSummary[]> {
    const records = await this.domains.listForProject(projectId);
    return records.map(toSummary);
  }

  get customDomainsUnavailableReason(): string | null {
    return this.options.customDomainsUnavailableReason;
  }

  get limit(): number {
    return this.options.maxPerProject;
  }

  async target(projectId: string): Promise<string | null> {
    const subdomain = await this.domains.subdomainOf(projectId);
    return subdomain
      ? deploymentHostFor(subdomain, hostWithoutPort(this.options.hostSuffix))
      : null;
  }

  async add(projectId: string, input: string): Promise<CustomDomainSummary> {
    if (this.options.customDomainsUnavailableReason) {
      throw new AppError('SERVICE_UNAVAILABLE', this.options.customDomainsUnavailableReason, {
        expose: true,
      });
    }

    const result = customDomainSchema.safeParse(input);

    if (!result.success) {
      throw new AppError('VALIDATION_FAILED', 'That domain cannot be used', {
        details: {
          fields: [
            { path: 'hostname', message: result.error.issues[0]?.message ?? 'Invalid domain' },
          ],
        },
      });
    }

    const hostname = result.data;

    if (hostname.endsWith(`.${hostWithoutPort(this.options.hostSuffix)}`)) {
      throw new AppError(
        'BAD_REQUEST',
        'That name is under this platform, so set it as the deployment address instead.',
        { expose: true, details: { field: 'hostname' } },
      );
    }

    const held = await this.domains.countForProject(projectId);
    if (held >= this.options.maxPerProject) {
      throw new AppError(
        'PAYLOAD_TOO_LARGE',
        `This project already has its limit of ${this.options.maxPerProject} domains.`,
      );
    }

    const added = await this.domains.add({
      projectId,
      hostname,
      verificationToken: randomBytes(24).toString('hex'),
    });

    if (!added.ok) {
      throw new AppError('CONFLICT', 'That domain is already in use.', {
        details: { field: 'hostname' },
      });
    }

    this.log.info({ projectId, hostname }, 'custom domain added');
    this.events?.publish(projectId, { type: 'deployments.changed' });

    return toSummary(added.domain);
  }

  async verify(projectId: string, domainId: string): Promise<CustomDomainSummary> {
    const record = await this.require(projectId, domainId);
    const expected = await this.target(projectId);

    const { provedByToken, provedByCname, txt, cname } = await this.pointsHere(record, expected);

    if (provedByToken || provedByCname) {
      const verified = await this.domains.recordCheck(record.id, {
        status: 'VERIFIED',
        message: null,
        verifiedAt: new Date(),
      });

      this.log.info(
        { projectId, hostname: record.hostname, by: provedByToken ? 'txt' : 'cname' },
        'custom domain verified',
      );
      this.events?.publish(projectId, { type: 'deployments.changed' });

      return toSummary(verified);
    }

    const message =
      txt === undefined && cname === undefined
        ? 'Nothing answered for that name yet. DNS changes can take a while to spread.'
        : `The records for that name do not point here yet. Looked for a TXT record at ${verificationRecordName(record.hostname)} containing the token, or a CNAME to ${expected ?? 'this project address'}.`;

    const checked = await this.domains.recordCheck(record.id, {
      status: record.status === 'VERIFIED' ? 'FAILED' : 'PENDING',
      message,
      ...(record.status === 'VERIFIED' ? { verifiedAt: null } : {}),
    });

    if (record.status === 'VERIFIED') {
      this.log.warn(
        { projectId, hostname: record.hostname },
        'a verified custom domain no longer points here',
      );
    }

    return toSummary(checked);
  }

  async remove(projectId: string, domainId: string): Promise<void> {
    const record = await this.require(projectId, domainId);

    await this.domains.remove(projectId, domainId);

    this.log.info({ projectId, hostname: record.hostname }, 'custom domain removed');
    this.events?.publish(projectId, { type: 'deployments.changed' });
  }

  async resolve(host: string): Promise<{ projectId: string } | { releaseLabel: string } | null> {
    const label = subdomainOf(host, this.options.hostSuffix);

    if (label) {
      const projectId = await this.domains.projectIdForSubdomain(label);
      return projectId ? { projectId } : { releaseLabel: label };
    }

    const record = await this.domains.findVerified(hostWithoutPort(host));
    return record ? { projectId: record.projectId } : null;
  }

  async projectFor(host: string): Promise<string | null> {
    const label = subdomainOf(host, this.options.hostSuffix);

    if (label) return this.domains.projectIdForSubdomain(label);

    const record = await this.domains.findVerified(hostWithoutPort(host));
    return record?.projectId ?? null;
  }

  async mayIssueCertificate(host: string): Promise<boolean> {
    const hostname = hostWithoutPort(host);
    if (hostname.length === 0) return false;

    if (this.previewSuffix) {
      const previewLabel = subdomainOf(hostname, this.previewSuffix);
      if (previewLabel) return this.domains.projectExists(previewLabel);
    }

    const label = subdomainOf(hostname, hostWithoutPort(this.options.hostSuffix));

    if (label) {
      if (await this.domains.projectIdForSubdomain(label)) return true;

      return (await this.releases?.exists(label)) ?? false;
    }

    return (await this.domains.findVerified(hostname)) !== null;
  }

  private releases?: { exists(label: string): Promise<boolean> };

  private previewSuffix: string | undefined;

  usePreviewHosts(suffix: string): void {
    this.previewSuffix = hostWithoutPort(suffix);
  }

  useReleases(releases: { exists(label: string): Promise<boolean> }): void {
    this.releases = releases;
  }

  async recheckVerified(options: {
    olderThanMs: number;
    missesBeforeLapse: number;
    limit: number;
  }): Promise<DomainRecheckReport> {
    const report: DomainRecheckReport = { checked: 0, stillPointing: 0, missed: 0, lapsed: 0 };
    const before = new Date(Date.now() - options.olderThanMs);

    for (const record of await this.domains.listDueForRecheck(before, options.limit)) {
      report.checked += 1;

      let pointing: boolean;
      try {
        const expected = await this.target(record.projectId);
        const answer = await this.pointsHere(record, expected, { strict: true });
        pointing = answer.provedByToken || answer.provedByCname;
      } catch (error) {
        this.log.warn(
          { err: error, hostname: record.hostname },
          'a domain could not be re-checked',
        );
        continue;
      }

      if (pointing) {
        report.stillPointing += 1;
        await this.domains.recordStillPointing(record.id);
        continue;
      }

      const misses = record.consecutiveMisses + 1;

      if (misses < options.missesBeforeLapse) {
        report.missed += 1;
        await this.domains.recordMiss(record.id, misses);
        continue;
      }

      report.lapsed += 1;
      await this.domains.recordMiss(record.id, misses);
      await this.domains.recordCheck(record.id, {
        status: 'FAILED',
        message: `This domain stopped pointing here: it was checked ${String(misses)} times in a row and was not. It is no longer served or given a certificate. Fix the DNS record and verify it again.`,
      });

      this.log.warn(
        { projectId: record.projectId, hostname: record.hostname, misses },
        'a custom domain stopped pointing here and was retired',
      );
      this.events?.publish(record.projectId, { type: 'deployments.changed' });
    }

    if (report.checked > 0) this.log.info({ report }, 'verified domains re-checked');
    return report;
  }

  private async pointsHere(
    record: DomainRecord,
    expected: string | null,
    how: { strict?: boolean } = {},
  ): Promise<{
    provedByToken: boolean;
    provedByCname: boolean;
    txt: string[] | undefined;
    cname: string[] | undefined;
  }> {
    const lookup = {
      timeoutMs: this.options.dnsTimeoutMs,
      servers: this.options.dnsServers,
      ...(how.strict ? { strict: true } : {}),
    };
    const resolver = this.options.resolver ?? { txt: resolveTxt, cname: resolveCname };

    const txt = await resolver.txt(verificationRecordName(record.hostname), lookup);
    const provedByToken = (txt ?? []).some((value) => value.trim() === record.verificationToken);

    const cname = provedByToken ? undefined : await resolver.cname(record.hostname, lookup);
    const provedByCname =
      expected !== null && (cname ?? []).some((value) => value === expected.toLowerCase());

    return { provedByToken, provedByCname, txt: txt ?? undefined, cname: cname ?? undefined };
  }

  private async require(projectId: string, domainId: string): Promise<DomainRecord> {
    const record = await this.domains.findById(projectId, domainId);
    if (!record) throw new AppError('NOT_FOUND', 'There is no domain with that identifier');
    return record;
  }

  private *candidates(base: string): Generator<string> {
    yield base;

    for (let suffix = 2; suffix <= MAX_SUBDOMAIN_ATTEMPTS; suffix += 1) {
      yield withSuffix(base, String(suffix));
    }

    yield withSuffix(base, randomBytes(4).toString('hex'));
  }
}

function toSummary(record: DomainRecord): CustomDomainSummary {
  return {
    id: record.id,
    hostname: record.hostname,
    status: record.status as DomainStatus,
    verificationToken: record.verificationToken,
    message: record.message,
    verifiedAt: record.verifiedAt?.toISOString() ?? null,
    lastCheckedAt: record.lastCheckedAt?.toISOString() ?? null,
    createdAt: record.createdAt.toISOString(),
  };
}

function sanitiseLabel(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SUBDOMAIN_LENGTH)
    .replace(/-+$/, '');
}

function withSuffix(base: string, suffix: string): string {
  const room = MAX_SUBDOMAIN_LENGTH - suffix.length - 1;
  return `${base.slice(0, room).replace(/-+$/, '')}-${suffix}`;
}

function hostWithoutPort(host: string): string {
  return host.toLowerCase().split(':')[0] ?? '';
}

function subdomainOf(host: string, suffix: string): string | undefined {
  const lower = hostWithoutPort(host);
  const tail = `.${hostWithoutPort(suffix)}`;

  if (!lower.endsWith(tail)) return undefined;

  const label = lower.slice(0, -tail.length);
  return label.length > 0 && !label.includes('.') ? label : undefined;
}
