import { Resolver } from 'node:dns/promises';

/**
 * Asking DNS a question, with a time limit.
 *
 * Its own file, small and dependency-free, for the same reason the HTTP probe
 * is: this is the one piece of domain verification that reaches outside the
 * machine, and it is the piece that has to be bounded. A resolver asked about a
 * name whose servers do not answer will wait, and the request holding it is
 * somebody pressing a button.
 *
 * A fresh resolver per lookup rather than the process-wide one, so a timeout set
 * for a verification cannot change how the rest of the platform resolves names.
 */

export interface DnsLookupOptions {
  timeoutMs: number;
  /**
   * Resolvers to ask, when an installation wants specific ones.
   *
   * Empty means the system's own. Worth having because a platform serving
   * custom domains is often behind a resolver that answers for internal names,
   * and verification needs the answer the public internet would get.
   */
  servers?: readonly string[];
  /**
   * Throw when the answer is inconclusive, instead of returning nothing.
   *
   * Off for verification, where "not proved yet" is the honest reading of every
   * failure and the person simply checks again. On for re-checking a domain
   * that is already verified, where a resolver that did not answer must not be
   * mistaken for a domain that has moved — or a resolver outage would retire
   * every domain on the installation.
   */
  strict?: boolean;
}

/**
 * A lookup that could not say either way: a timeout, a server failure, a
 * refused query. Distinct from a name or record that is definitively absent.
 */
export class DnsInconclusiveError extends Error {
  constructor(readonly code: string) {
    super(`DNS did not give a definite answer (${code}).`);
    this.name = 'DnsInconclusiveError';
  }
}

/** Answers that really do mean "not there". Anything else is inconclusive. */
const DEFINITIVE = new Set(['ENODATA', 'ENOTFOUND', 'ENOTIMP', 'EBADNAME']);

/**
 * Every TXT record at a name, flattened.
 *
 * DNS splits a long TXT value into chunks of at most 255 characters, and a
 * resolver hands them back as an array per record. Joining them is not a
 * convenience: a token longer than 255 characters would otherwise never match
 * anything, and the join is how the value is meant to be read.
 */
export async function resolveTxt(
  hostname: string,
  options: DnsLookupOptions,
): Promise<string[] | undefined> {
  return lookup(options, async (resolver) => {
    const records = await resolver.resolveTxt(hostname);
    return records.map((chunks) => chunks.join(''));
  });
}

/** Every CNAME target at a name, lowercased and without the trailing dot. */
export async function resolveCname(
  hostname: string,
  options: DnsLookupOptions,
): Promise<string[] | undefined> {
  return lookup(options, async (resolver) => {
    const records = await resolver.resolveCname(hostname);
    return records.map((value) => value.toLowerCase().replace(/\.$/, ''));
  });
}

/**
 * Runs one lookup, bounded.
 *
 * Returns undefined for every failure rather than throwing, and the caller
 * treats that as "not proved". The distinction between a name that does not
 * exist, a server that did not answer, and a record that is not there matters
 * to somebody debugging their DNS and not to the platform: none of them is
 * proof of control, which is the only question being asked.
 */
async function lookup(
  options: DnsLookupOptions,
  work: (resolver: Resolver) => Promise<string[]>,
): Promise<string[] | undefined> {
  const resolver = new Resolver({ timeout: options.timeoutMs, tries: 1 });
  if (options.servers && options.servers.length > 0) resolver.setServers([...options.servers]);

  const timer = setTimeout(() => resolver.cancel(), options.timeoutMs);

  try {
    return await work(resolver);
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (options.strict && !(typeof code === 'string' && DEFINITIVE.has(code))) {
      throw new DnsInconclusiveError(typeof code === 'string' ? code : 'UNKNOWN');
    }
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}
