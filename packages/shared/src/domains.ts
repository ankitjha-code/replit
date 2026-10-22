import { z } from 'zod';

export const MAX_SUBDOMAIN_LENGTH = 63;

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

const LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

export const deploymentSubdomainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1, 'Enter a name')
  .max(MAX_SUBDOMAIN_LENGTH, `A name may be at most ${MAX_SUBDOMAIN_LENGTH} characters`)
  .regex(LABEL_PATTERN, 'Use letters, numbers and hyphens, not starting or ending with a hyphen')
  .refine((value) => !RESERVED_SUBDOMAINS.has(value), 'That name is reserved by the platform')
  .refine((value) => !/^..--/.test(value), 'That name has a reserved shape');

export const setDeploymentSubdomainRequestSchema = z.object({
  subdomain: deploymentSubdomainSchema,
});

export type SetDeploymentSubdomainRequest = z.infer<typeof setDeploymentSubdomainRequestSchema>;

export function deploymentHostFor(subdomain: string, suffix: string): string {
  return `${subdomain}.${suffix}`;
}

export const MAX_DOMAIN_LENGTH = 253;

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

export const DOMAIN_STATUSES = ['PENDING', 'VERIFIED', 'FAILED'] as const;

export type DomainStatus = (typeof DOMAIN_STATUSES)[number];

export const DOMAIN_VERIFICATION_PREFIX = '_platform-verify';

export function verificationRecordName(hostname: string): string {
  return `${DOMAIN_VERIFICATION_PREFIX}.${hostname}`;
}

export const customDomainSummarySchema = z.object({
  id: z.string(),
  hostname: z.string(),
  status: z.enum(DOMAIN_STATUSES),
  verificationToken: z.string(),
  message: z.string().nullable(),
  verifiedAt: z.string().nullable(),
  lastCheckedAt: z.string().nullable(),
  createdAt: z.string(),
});

export type CustomDomainSummary = z.infer<typeof customDomainSummarySchema>;

export const customDomainListResponseSchema = z.object({
  domains: z.array(customDomainSummarySchema),
  subdomain: z.string().nullable(),
  target: z.string().nullable(),
  verificationPrefix: z.string(),
  unavailableReason: z.string().nullable(),
  limit: z.number().int().positive(),
});

export type CustomDomainListResponse = z.infer<typeof customDomainListResponseSchema>;

export const customDomainResponseSchema = z.object({ domain: customDomainSummarySchema });

export type CustomDomainResponse = z.infer<typeof customDomainResponseSchema>;
