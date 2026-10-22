import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { DnsInconclusiveError } from '../../lib/probes/dns.js';
import type { DomainRecord, DomainRepository } from './domain.repository.js';
import { DomainService } from './domain.service.js';

function domain(overrides: Partial<DomainRecord> = {}): DomainRecord {
  return {
    id: 'd-1',
    projectId: 'p-1',
    hostname: 'shop.example.test',
    status: 'VERIFIED',
    verificationToken: 'token-123',
    message: null,
    verifiedAt: new Date(),
    lastCheckedAt: null,
    consecutiveMisses: 0,
    createdAt: new Date(),
    ...overrides,
  };
}

function build(record: DomainRecord, answer: 'pointing' | 'gone' | 'inconclusive') {
  const events: string[] = [];

  const repository = {
    listDueForRecheck: () => Promise.resolve([record]),
    recordStillPointing: () => {
      events.push('still-pointing');
      return Promise.resolve();
    },
    recordMiss: (_id: string, misses: number) => {
      events.push(`miss:${misses}`);
      return Promise.resolve();
    },
    recordCheck: (_id: string, input: { status: string }) => {
      events.push(`status:${input.status}`);
      return Promise.resolve(record);
    },
    subdomainOf: () => Promise.resolve('shop'),
  } as unknown as DomainRepository;

  const resolver = {
    txt: () => {
      if (answer === 'inconclusive') return Promise.reject(new DnsInconclusiveError('ETIMEOUT'));
      return Promise.resolve(answer === 'pointing' ? ['token-123'] : undefined);
    },
    cname: () => Promise.resolve(undefined),
  };

  const service = new DomainService(
    repository,
    {
      hostSuffix: 'app.localhost',
      scheme: 'http',
      maxPerProject: 5,
      dnsTimeoutMs: 1_000,
      dnsServers: [],
      customDomainsUnavailableReason: null,
      resolver: resolver as never,
    },
    pino({ level: 'silent' }),
  );

  const run = () => service.recheckVerified({ olderThanMs: 0, missesBeforeLapse: 3, limit: 10 });

  return { run, events };
}

describe('re-checking verified domains', () => {
  it('resets the count when a domain still points here', async () => {
    const { run, events } = build(domain({ consecutiveMisses: 2 }), 'pointing');
    await run();
    expect(events).toEqual(['still-pointing']);
  });

  it('counts a miss without retiring the domain', async () => {
    // One bad lookup must not take somebody's site down.
    const { run, events } = build(domain({ consecutiveMisses: 0 }), 'gone');
    await run();
    expect(events).toEqual(['miss:1']);
  });

  it('retires it only on the miss that reaches the limit', async () => {
    const { run, events } = build(domain({ consecutiveMisses: 2 }), 'gone');
    const report = await run();
    expect(events).toEqual(['miss:3', 'status:FAILED']);
    expect(report.lapsed).toBe(1);
  });

  it('does not count a resolver that did not answer as a miss', async () => {
    // Otherwise a resolver outage would retire every domain on the installation.
    const { run, events } = build(domain({ consecutiveMisses: 2 }), 'inconclusive');
    const report = await run();
    expect(events).toEqual([]);
    expect(report.lapsed).toBe(0);
  });
});
