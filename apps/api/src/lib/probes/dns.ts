import { Resolver } from 'node:dns/promises';

export interface DnsLookupOptions {
  timeoutMs: number;
  servers?: readonly string[];
  strict?: boolean;
}

export class DnsInconclusiveError extends Error {
  constructor(readonly code: string) {
    super(`DNS did not give a definite answer (${code}).`);
    this.name = 'DnsInconclusiveError';
  }
}

const DEFINITIVE = new Set(['ENODATA', 'ENOTFOUND', 'ENOTIMP', 'EBADNAME']);

export async function resolveTxt(
  hostname: string,
  options: DnsLookupOptions,
): Promise<string[] | undefined> {
  return lookup(options, async (resolver) => {
    const records = await resolver.resolveTxt(hostname);
    return records.map((chunks) => chunks.join(''));
  });
}

export async function resolveCname(
  hostname: string,
  options: DnsLookupOptions,
): Promise<string[] | undefined> {
  return lookup(options, async (resolver) => {
    const records = await resolver.resolveCname(hostname);
    return records.map((value) => value.toLowerCase().replace(/\.$/, ''));
  });
}

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
