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

/**
 * The addresses a deployed project answers on.
 *
 * Two kinds, and the difference between them is the whole file. A **subdomain**
 * is a label under the platform's own domain: the platform controls it, can
 * refuse names that would collide with itself, and can serve it the instant it
 * is set. A **custom domain** is somebody else's name pointed here, and the
 * platform controls nothing about it.
 *
 * That second case is the one with teeth. Anybody can type any hostname into a
 * form. If a claim alone were enough:
 *
 *  - Whoever claimed a name first would receive traffic meant for its real
 *    owner, from browsers that had been told to come here.
 *  - The platform would ask a certificate authority for a certificate covering
 *    a name it has no business holding, which is the part that turns a product
 *    bug into an abuse of the public certificate system.
 *
 * So nothing is served on a custom domain until its owner has proved control by
 * publishing a record only they could publish. Verification is rechecked rather
 * than remembered: DNS can be repointed by whoever holds it, and a name that
 * stopped pointing here should stop being claimed here.
 */

export interface DomainServiceOptions {
  /** The platform's own domain suffix, which subdomains sit under. */
  hostSuffix: string;
  /** How a deployment address is spelled. */
  scheme: string;
  /** Custom domains one project may hold. */
  maxPerProject: number;
  /** How long a DNS lookup may take before it is abandoned. */
  dnsTimeoutMs: number;
  /** Resolvers to ask, when an installation wants specific ones. */
  dnsServers: readonly string[];
  /**
   * Why custom domains cannot be used here, or null when they can.
   *
   * An installation on `localhost` cannot usefully serve a custom domain: there
   * is nothing for one to be pointed at. Saying so beats offering a form whose
   * every submission fails verification.
   */
  customDomainsUnavailableReason: string | null;
  /**
   * How DNS is asked. The real resolver unless a test supplies one: the
   * decisions here are about what an answer means, and a test that depended on
   * a real zone would be testing the zone.
   */
  resolver?: {
    txt: typeof resolveTxt;
    cname: typeof resolveCname;
  };
}

/** What re-checking verified domains found, for the log. */
export interface DomainRecheckReport {
  checked: number;
  stillPointing: number;
  missed: number;
  lapsed: number;
}

/** How many attempts at a readable subdomain before falling back to a random tail. */
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

  // --- The platform's own subdomain ----------------------------------------

  /**
   * The label this project answers on, assigning one if it has none.
   *
   * Assigned on first use rather than at project creation, because a name
   * nobody is using is a name taken from everybody else for nothing. Derived
   * from the project's slug, which is the name its owner already chose, with a
   * numbered variant when that is taken and a random tail when the numbered
   * ones run out. The last of those is ugly and always terminates, which
   * matters more here than being pretty.
   */
  async ensureSubdomain(projectId: string): Promise<string> {
    const held = await this.domains.subdomainOf(projectId);
    if (held) return held;

    const slug = (await this.domains.slugOf(projectId)) ?? '';
    const base = sanitiseLabel(slug) || 'project';

    for (const candidate of this.candidates(base)) {
      if (RESERVED_SUBDOMAINS.has(candidate)) continue;
      if (await this.domains.subdomainTaken(candidate)) continue;

      // The unique index decides, not the check above: two projects can pass it
      // at the same moment, and losing that race is ordinary.
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

  /** Changes the label, refusing one somebody else holds. */
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

  /**
   * Where one release answers, as opposed to where the project does.
   *
   * Built from the label and this installation's own domain rather than stored
   * anywhere, so changing the domain does not leave every past release
   * advertising an address that no longer resolves.
   *
   * Deliberately not checked against anything. This says what a label's address
   * *would* be; whether a release is running on it is the deployment's question,
   * and asking here would make building a URL a database round trip.
   */
  releaseAddress(label: string): string {
    return `${this.options.scheme}://${deploymentHostFor(label, this.options.hostSuffix)}`;
  }

  /** Where this project's deployment answers, or null before it has an address. */
  async addressOf(projectId: string): Promise<{ subdomain: string; url: string } | null> {
    const subdomain = await this.domains.subdomainOf(projectId);
    if (!subdomain) return null;

    return {
      subdomain,
      url: `${this.options.scheme}://${deploymentHostFor(subdomain, this.options.hostSuffix)}`,
    };
  }

  // --- Custom domains -------------------------------------------------------

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

  /** What a custom domain should be pointed at, for the instructions on screen. */
  async target(projectId: string): Promise<string | null> {
    const subdomain = await this.domains.subdomainOf(projectId);
    return subdomain
      ? deploymentHostFor(subdomain, hostWithoutPort(this.options.hostSuffix))
      : null;
  }

  /**
   * Claims a hostname for this project, unverified.
   *
   * Nothing is served on it yet. What comes back is the token to publish, and
   * publishing it under a name is exactly the act only its owner can perform.
   */
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

    /*
     * A name under the platform's own domain is refused.
     *
     * Those are the platform's to assign, and one added here would be a second
     * row claiming an address the subdomain lookup already answers for. Which
     * of the two won would then depend on the order the listener happened to
     * ask its questions.
     */
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
      // 32 bytes of randomness, hex-encoded. Nothing is derived from the
      // hostname: a token somebody could compute would prove nothing.
      verificationToken: randomBytes(24).toString('hex'),
    });

    if (!added.ok) {
      /*
       * Somebody already has it, and who is not said.
       *
       * Answering "another project here has that domain" would let anybody
       * enumerate which domains this installation serves, which is exactly the
       * list an attacker wants before trying to take one over.
       */
      throw new AppError('CONFLICT', 'That domain is already in use.', {
        details: { field: 'hostname' },
      });
    }

    this.log.info({ projectId, hostname }, 'custom domain added');
    this.events?.publish(projectId, { type: 'deployments.changed' });

    return toSummary(added.domain);
  }

  /**
   * Checks whether the domain is really pointed here, and records what it saw.
   *
   * Two ways to prove it, because the right one depends on where the name sits:
   *
   *  - A **TXT record** under a dedicated label. Works for a bare domain, which
   *    cannot carry a CNAME at all, and never disturbs where the name resolves.
   *  - A **CNAME** pointing at this project's platform address. Works for a
   *    subdomain, and has the advantage of being the record that actually makes
   *    the domain work: if it is there, traffic is already arriving.
   *
   * Either is enough. Requiring both would mean a bare domain could never be
   * verified, and requiring only the TXT would let somebody verify a name they
   * had not actually pointed here.
   */
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

    /*
     * Not proved, which is not the same as failed for good.
     *
     * DNS takes time to propagate, so the commonest reason for a check not
     * passing is that it is too early. The message says what was looked for and
     * what was found, because the person reading it is about to go and edit a
     * zone file and needs to know which.
     */
    const message =
      txt === undefined && cname === undefined
        ? 'Nothing answered for that name yet. DNS changes can take a while to spread.'
        : `The records for that name do not point here yet. Looked for a TXT record at ${verificationRecordName(record.hostname)} containing the token, or a CNAME to ${expected ?? 'this project address'}.`;

    const checked = await this.domains.recordCheck(record.id, {
      // Left PENDING rather than moved to FAILED. Somebody who has just added a
      // domain and checked too early has not failed at anything.
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

  // --- Resolution, for the public listener -----------------------------------

  /**
   * The project a request's hostname belongs to, or null.
   *
   * Two lookups in a fixed order: the platform's own domain first, then a
   * verified custom domain. Fixed, because a name can only be one of the two —
   * a custom domain under the platform's own suffix is refused when it is added
   * — and an order is easier to be sure of than an argument about precedence.
   */
  /**
   * Turns a hostname into whatever it names.
   *
   * A label under the platform's own domain is either a project's address or a
   * single release's. They are told apart by asking: a project subdomain is a
   * row, and anything else that looks like a label is offered to the deployment
   * service as a release. Nothing is parsed apart on a separator, which would
   * mean a project whose chosen subdomain contained one became ambiguous.
   *
   * A custom domain is always a project's. Somebody pointing their own domain at
   * a single release rather than at "whatever is live" is not a thing anybody
   * has asked for, and it would make a rollback silently not reach them.
   */
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

  /**
   * Whether the platform should hold a certificate for a hostname.
   *
   * Asked by the reverse proxy before it obtains one, and the only reason a
   * certificate is not requested for anything anybody types: a proxy that
   * issued on demand without asking would let one request make the platform ask
   * a certificate authority about a name it has never heard of, which is how an
   * installation gets rate-limited or worse.
   */
  async mayIssueCertificate(host: string): Promise<boolean> {
    const hostname = hostWithoutPort(host);
    if (hostname.length === 0) return false;

    /*
     * A project's preview address, `<projectId>.<preview suffix>`.
     *
     * Previews need HTTPS in production too — their viewing cookie is only
     * sent when `Secure` — and a wildcard certificate would need the DNS
     * provider's API, which is a paid or provider-specific dependency. Issuing
     * per preview host, only for projects that exist, keeps the answer closed.
     */
    if (this.previewSuffix) {
      const previewLabel = subdomainOf(hostname, this.previewSuffix);
      if (previewLabel) return this.domains.projectExists(previewLabel);
    }

    const label = subdomainOf(hostname, hostWithoutPort(this.options.hostSuffix));

    if (label) {
      if (await this.domains.projectIdForSubdomain(label)) return true;

      /*
       * A release's own address needs a certificate too.
       *
       * Without this, per-release addresses work on plain HTTP and fail on
       * every installation that has TLS — which is every real one. It is still
       * a closed answer: the label has to name a release that exists, so this
       * does not become "issue for anything anybody types".
       */
      return (await this.releases?.exists(label)) ?? false;
    }

    return (await this.domains.findVerified(hostname)) !== null;
  }

  /**
   * Told how to recognise a release's own address, after construction.
   *
   * Set this way rather than taken as a constructor argument because the
   * deployment service already depends on this one: asking for it here would be
   * a cycle. What it needs is one question answered, so that is the whole
   * interface.
   */
  private releases?: { exists(label: string): Promise<boolean> };

  /** Where previews live, so their hostnames can be given certificates. */
  private previewSuffix: string | undefined;

  usePreviewHosts(suffix: string): void {
    this.previewSuffix = hostWithoutPort(suffix);
  }

  useReleases(releases: { exists(label: string): Promise<boolean> }): void {
    this.releases = releases;
  }

  /**
   * Re-checks verified domains, and retires one that has stopped pointing here.
   *
   * ## Why
   *
   * Verification proves control at one moment. A domain can be sold, lapse, or
   * be repointed afterwards, and a platform that went on serving it and asking
   * for certificates for it would be serving this project under a name somebody
   * else now controls. Nothing noticed until now.
   *
   * ## Not on the first miss
   *
   * DNS has bad minutes. A domain is retired only after several re-checks in a
   * row have missed, spread across the re-check interval — hours, not seconds —
   * so a resolver hiccup costs a counter and not somebody's site. Any check that
   * finds it pointing here again resets the count.
   *
   * Retiring it is marking it failed, and the rules that already exist do the
   * rest: only verified domains are routed, and only verified domains get
   * certificates. The owner can verify it again once they have fixed the record.
   */
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
        // A lookup that failed outright is not evidence of anything. Skipped,
        // and not counted as a miss, so an outage of the resolver cannot retire
        // every domain on the installation.
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

  /** Asks DNS whether a hostname is proved by its token or points at the project. */
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

  // -------------------------------------------------------------------------

  private async require(projectId: string, domainId: string): Promise<DomainRecord> {
    const record = await this.domains.findById(projectId, domainId);
    if (!record) throw new AppError('NOT_FOUND', 'There is no domain with that identifier');
    return record;
  }

  /** Readable variants of a base label, then one that always works. */
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

/** A slug reduced to something that is a valid DNS label. */
function sanitiseLabel(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SUBDOMAIN_LENGTH)
    .replace(/-+$/, '');
}

/** Appends a distinguishing tail, keeping the whole thing inside the limit. */
function withSuffix(base: string, suffix: string): string {
  const room = MAX_SUBDOMAIN_LENGTH - suffix.length - 1;
  return `${base.slice(0, room).replace(/-+$/, '')}-${suffix}`;
}

/** The hostname without its port, which a Host header carries and a name does not. */
function hostWithoutPort(host: string): string {
  return host.toLowerCase().split(':')[0] ?? '';
}

/**
 * The label a host sits under a suffix as, ignoring ports on either side.
 *
 * The configured suffix carries a port in development (`localhost:4200`) and
 * not in production, and a Host header carries one when it is not the default.
 * Comparing the two without stripping both would make the same address match in
 * one environment and not the other.
 */
function subdomainOf(host: string, suffix: string): string | undefined {
  const lower = hostWithoutPort(host);
  const tail = `.${hostWithoutPort(suffix)}`;

  if (!lower.endsWith(tail)) return undefined;

  const label = lower.slice(0, -tail.length);
  return label.length > 0 && !label.includes('.') ? label : undefined;
}
