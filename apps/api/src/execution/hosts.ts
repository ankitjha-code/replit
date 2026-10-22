import { z } from 'zod';

const hostNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(32)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'A host name may contain lowercase letters, digits and hyphens');

export const executionHostSchema = z.object({
  name: hostNameSchema,

  socketPath: z.string().min(1).optional(),
  url: z.string().url().optional(),

  cpuMillicores: z.number().int().min(100),
  memoryMb: z.number().int().min(128),

  maxWorkloads: z.number().int().min(1).default(50),

  schedulable: z.boolean().default(true),
});

export type ExecutionHostConfig = z.infer<typeof executionHostSchema>;

export const executionHostsSchema = z
  .array(executionHostSchema)
  .min(1)
  .refine(
    (hosts) => new Set(hosts.map((host) => host.name)).size === hosts.length,
    'Two execution hosts cannot share a name',
  );

export function parseExecutionHosts(raw: string): ExecutionHostConfig[] {
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('EXECUTION_HOSTS is not valid JSON');
  }

  const result = executionHostsSchema.safeParse(parsed);

  if (!result.success) {
    throw new Error(
      `EXECUTION_HOSTS is not a usable list of hosts: ${result.error.issues[0]?.message ?? 'invalid'}`,
    );
  }

  return result.data;
}

export function encodeWorkloadId(host: string, externalId: string): string {
  return `${host}/${externalId}`;
}

export function decodeWorkloadId(
  value: string,
  defaultHost: string,
): { host: string; externalId: string } {
  const separator = value.indexOf('/');

  if (separator === -1) return { host: defaultHost, externalId: value };

  return {
    host: value.slice(0, separator),
    externalId: value.slice(separator + 1),
  };
}
