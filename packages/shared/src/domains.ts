import { z } from 'zod';

/**
 * The addresses a deployed project answers on.
 *
 * Two kinds, and they are different in the one way that matters: the platform
 * owns one of them and does not own the other.
 *
 * A **subdomain** is a label under the platform's own domain. The platform can
 * be sure it controls it, can refuse names that would collide with itself, and
 * can serve it the moment it is set.
 *
 * A **custom domain** is somebody else's name pointed at the platform. Anybody
 * can claim to own `example.com`, so nothing is served on one until its owner
 * has proved control by putting a record in its DNS. Without that, a person who
 * claimed a domain first would receive traffic meant for its real owner, and
 * the platform would issue a certificate for a name it had no business holding.
 */

/** A DNS label: the part before the platform's own suffix. */
export const MAX_SUBDOMAIN_LENGTH = 63;

/**
 * Labels the platform keeps for itself.
 *
 * Longer than the reserved project slugs, because a project slug is always
 * scoped by its owner in a URL and this is not: a subdomain sits directly under
 * the platform's domain, beside whatever else the platform serves there.
 */
export const RESERVED_SUBDOMAINS: ReadonlySet<string> = new Set([
  'admin',
  'api',
  'app',
  'assets',
  'auth',
  'blog',
  'cdn',
  'console',
  'dashboard',
  'deploy',
  'dev',
  'docs',
  'files',
  'ftp',
  'git',
  'help',
  'host',
  'internal',
  'login',
  'mail',
  'metrics',
  'ns1',
  'ns2',
  'preview',
  'proxy',
  'registry',
  'root',
  'smtp',
  'ssl',
  'staging',
  'static',
  'status',
  'support',
  'system',
  'test',
  'www',
]);

/**
 * A single DNS label, as the specification defines one.
 *
 * Letters, digits and hyphens, never starting or ending with a hyphen. Not a
 * platform preference: a label outside this set is not resolvable, so accepting
 * one would store an address that can never work.
 */
const LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

export const deploymentSubdomainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1, 'Enter a name')
  .max(MAX_SUBDOMAIN_LENGTH, `A name may be at most ${MAX_SUBDOMAIN_LENGTH} characters`)
  .regex(LABEL_PATTERN, 'Use letters, numbers and hyphens, not starting or ending with a hyphen')
  .refine((value) => !RESERVED_SUBDOMAINS.has(value), 'That name is reserved by the platform')
  /*
   * Two consecutive hyphens at the third and fourth position are reserved.
   *
   * That shape means "this is a punycode-encoded internationalised name" to
   * every resolver, and a label that claims to be one and is not confuses
   * things that decode it.
   */
  .refine((value) => !/^..--/.test(value), 'That name has a reserved shape');

export const setDeploymentSubdomainRequestSchema = z.object({
  subdomain: deploymentSubdomainSchema,
});

export type SetDeploymentSubdomainRequest = z.infer<typeof setDeploymentSubdomainRequestSchema>;

/** The address a project's deployment answers on, under the platform's domain. */
export function deploymentHostFor(subdomain: string, suffix: string): string {
  return `${subdomain}.${suffix}`;
}

/*
 * There is deliberately no "read the label out of a Host header" helper here.
 *
 * Doing it correctly means stripping the port from both the header and the
 * configured suffix, and then looking the result up — a Host header carries a
 * port when it is not the default one, and the suffix carries one in
 * development and not in production. That is a decision with a database query
 * on the end of it, so it lives in the domain service where the query is,
 * rather than as a string function that would be right in one environment and
 * quietly wrong in the other.
 */

// ---------------------------------------------------------------------------
// Custom domains
// ---------------------------------------------------------------------------

/** The longest hostname DNS allows, which is also what the column holds. */
export const MAX_DOMAIN_LENGTH = 253;

/**
 * A hostname somebody else owns.
 *
 * Deliberately strict. This becomes a lookup key for incoming requests and,
 * once verified, the name on a certificate the platform asks for. A hostname
 * with a trailing dot, an underscore, or uppercase in it would be the same name
 * spelled differently, and two spellings of one name is two rows claiming one
 * address.
 */
export const customDomainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(4, 'Enter a domain name')
  .max(MAX_DOMAIN_LENGTH)
  .refine((value) => !value.endsWith('.'), 'Leave off the trailing dot')
  .refine((value) => value.includes('.'), 'A domain needs at least one dot')
  .refine(
    (value) => value.split('.').every((label) => LABEL_PATTERN.test(label)),
    'Each part may contain letters, numbers and hyphens, not starting or ending with a hyphen',
  )
  .refine((value) => value.split('.').every((label) => label.length <= 63), 'One part is too long');

export const addCustomDomainRequestSchema = z.object({ hostname: customDomainSchema });

export type AddCustomDomainRequest = z.infer<typeof addCustomDomainRequestSchema>;

/**
 * Where a domain stands.
 *
 * Nothing is served on a domain that is not VERIFIED, and verification is
 * rechecked rather than remembered for ever: DNS can be repointed by whoever
 * controls it, and a domain that stopped pointing here should stop being
 * claimed here.
 */
export const DOMAIN_STATUSES = ['PENDING', 'VERIFIED', 'FAILED'] as const;

export type DomainStatus = (typeof DOMAIN_STATUSES)[number];

/** The label a verification record is published under. */
export const DOMAIN_VERIFICATION_PREFIX = '_platform-verify';

/** What to publish, and where, to prove control of a domain. */
export function verificationRecordName(hostname: string): string {
  return `${DOMAIN_VERIFICATION_PREFIX}.${hostname}`;
}

export const customDomainSummarySchema = z.object({
  id: z.string(),
  hostname: z.string(),
  status: z.enum(DOMAIN_STATUSES),
  /**
   * The value to publish in DNS.
   *
   * Shown to the person adding the domain, and no use to anybody else: proving
   * control means being able to publish it under a name they already own.
   */
  verificationToken: z.string(),
  /** What the last check saw, when it did not pass. Safe to show. */
  message: z.string().nullable(),
  verifiedAt: z.string().nullable(),
  lastCheckedAt: z.string().nullable(),
  createdAt: z.string(),
});

export type CustomDomainSummary = z.infer<typeof customDomainSummarySchema>;

export const customDomainListResponseSchema = z.object({
  domains: z.array(customDomainSummarySchema),
  /**
   * The label this project answers on under the platform's own domain.
   *
   * Null until the project is first deployed, because a name nobody is using is
   * a name taken from everybody else for nothing.
   */
  subdomain: z.string().nullable(),
  /**
   * What a custom domain should be pointed at.
   *
   * The platform's own address for this project, so the instructions on screen
   * are the instructions for this installation rather than for the one the
   * documentation was written on.
   */
  target: z.string().nullable(),
  /** The DNS label a verification record goes under. */
  verificationPrefix: z.string(),
  /** Why custom domains cannot be used here, or null when they can. */
  unavailableReason: z.string().nullable(),
  /** How many one project may hold. */
  limit: z.number().int().positive(),
});

export type CustomDomainListResponse = z.infer<typeof customDomainListResponseSchema>;

export const customDomainResponseSchema = z.object({ domain: customDomainSummarySchema });

export type CustomDomainResponse = z.infer<typeof customDomainResponseSchema>;
