import { z } from 'zod';

/**
 * The machines that can run workloads.
 *
 * Until now there was one, implicitly: a Docker socket path, and everything the
 * platform started went there. One host is a ceiling on the whole installation —
 * every project's container, every build, every deployment, competing for one
 * machine's processor and memory — and it is the ceiling you hit first.
 *
 * A host is declared rather than discovered. The platform does not go looking
 * for machines, and it does not infer capacity from what a machine reports about
 * itself: an operator says what exists and how much of it may be used. Anything
 * else would have the platform filling a machine that is also doing something
 * else.
 */

/**
 * A name, used in logs, in workload identifiers, and in the health page.
 *
 * Narrow because it becomes part of an identifier the platform stores and later
 * splits apart: a name containing a slash would make that identifier ambiguous,
 * and the ambiguity would show up as a workload nobody could find.
 */
const hostNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(32)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'A host name may contain lowercase letters, digits and hyphens');

export const executionHostSchema = z.object({
  name: hostNameSchema,

  /**
   * Where the container runtime listens.
   *
   * A socket path for a machine this process is on, or a URL for one it is not.
   * Undefined means the default socket, which is what a single-host installation
   * has always used.
   */
  socketPath: z.string().min(1).optional(),
  url: z.string().url().optional(),

  /**
   * How much of the machine the platform may place on it.
   *
   * Declared, not measured. A machine's own total is the wrong number: it
   * includes whatever else runs there, and a platform that scheduled against it
   * would fill a host that was already busy. What an operator writes here is a
   * budget the platform stays inside.
   */
  cpuMillicores: z.number().int().min(100),
  memoryMb: z.number().int().min(128),

  /**
   * A ceiling on how many workloads may sit on one host regardless of size.
   *
   * Processor and memory are not the only things a host runs out of: file
   * descriptors, network namespaces, and the container runtime's own bookkeeping
   * all degrade long before a well-sized machine is nominally full.
   */
  maxWorkloads: z.number().int().min(1).default(50),

  /**
   * Whether new workloads may be placed here.
   *
   * False takes a host out of the rotation without taking it away: what is
   * already on it keeps running and keeps being reachable, and nothing new
   * arrives. That is what makes draining a host for maintenance possible at all.
   */
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

/**
 * Reads the host list out of configuration.
 *
 * JSON rather than a bespoke delimited format, because a host has six fields and
 * a format invented here would need its own parser, its own escaping rules and
 * its own errors. A malformed list is a refusal at startup: an installation that
 * meant to run several hosts and silently ran one would be worse than one that
 * will not start.
 */
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

/**
 * The identifier a routed workload is known by.
 *
 * `host/id`, and the reason it is encoded rather than carried in a second field
 * is worth stating: every layer above the execution plane already treats this
 * value as opaque — the port says so — and stores it as a single column. Adding
 * a host field would mean threading it through a dozen call sites that have no
 * business knowing there is more than one machine.
 *
 * The name is validated on the way in, so it cannot contain the separator.
 */
export function encodeWorkloadId(host: string, externalId: string): string {
  return `${host}/${externalId}`;
}

/**
 * Splits one apart, tolerating an identifier from before hosts existed.
 *
 * An unencoded identifier belongs to the host that was the only one at the time,
 * which is the default. That is not a courtesy to old data: it is what lets an
 * installation add a second host without every running container becoming
 * unreachable.
 */
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
