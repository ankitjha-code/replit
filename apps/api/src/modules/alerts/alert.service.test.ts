import type { WatchedWorkload } from '@platform/shared';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import type { MailMessage, MailProvider } from '../../mail/provider.js';
import type { AlertRepository, AlertStateRecord } from './alert.repository.js';
import { AlertService } from './alert.service.js';

const PROJECT = '018f0000-0000-7000-8000-0000000000aa';

function harness(options: { verified?: boolean; mailDown?: boolean; memoryPercent?: number } = {}) {
  let record: AlertStateRecord = {
    projectId: PROJECT,
    enabled: true,
    failuresBeforeAlert: 3,
    memoryPercent: options.memoryPercent ?? null,
    consecutiveFailures: 0,
    healthFiring: false,
    memoryFiring: false,
    lastCheckedAt: null,
  };
  const events: { kind: string; state: string; message: string; notified: boolean }[] = [];
  const sent: MailMessage[] = [];
  let reading: WatchedWorkload | null = null;

  const repository = {
    find: async () => record,
    saveState: async (_id: string, state: Partial<AlertStateRecord>) => {
      record = { ...record, ...state };
    },
    recordEvent: async (_id: string, event: (typeof events)[number]) => {
      events.push(event);
    },
    events: async () => [],
    recipient: async () => ({
      email: 'ada@example.test',
      emailVerified: options.verified ?? true,
      username: 'ada',
      projectName: 'Shop',
    }),
  } as unknown as AlertRepository;

  const mail: MailProvider = {
    name: 'test',
    unavailableReason: async () => (options.mailDown ? 'no SMTP server is configured' : null),
    send: async (message) => {
      sent.push(message);
    },
  };

  const service = new AlertService(
    repository,
    { deploymentReading: async () => reading },
    mail,
    { checkIntervalMs: 60_000, batchSize: 10, eventsShown: 10, publicUrl: 'http://web.test' },
    pino({ level: 'silent' }),
  );

  const workload = (state: 'healthy' | 'unhealthy' | 'unreachable' | 'unknown', memory?: number) =>
    ({
      kind: 'DEPLOYMENT',
      id: 'd-1',
      label: 'Server',
      history: [],
      usage:
        memory === undefined
          ? null
          : {
              cpuMillicores: 10,
              cpuLimitMillicores: 1000,
              memoryBytes: memory,
              memoryLimitBytes: 100,
              pids: 1,
              pidsLimit: 10,
              at: new Date().toISOString(),
            },
      health: { state, statusCode: null, latencyMs: null, checkedAt: null, message: null },
    }) as WatchedWorkload;

  return {
    events,
    sent,
    get record() {
      return record;
    },
    async tick(next: WatchedWorkload | null) {
      reading = next;
      await service.check(record);
    },
    workload,
  };
}

describe('health alerts', () => {
  it('starts only after the configured number of failures in a row, and emails once', async () => {
    const h = harness();
    await h.tick(h.workload('unhealthy'));
    await h.tick(h.workload('unreachable'));
    expect(h.events).toHaveLength(0);

    await h.tick(h.workload('unhealthy'));
    await h.tick(h.workload('unhealthy'));
    await h.tick(h.workload('unhealthy'));

    expect(h.events).toEqual([
      expect.objectContaining({ kind: 'HEALTH', state: 'FIRING', notified: true }),
    ]);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.to).toBe('ada@example.test');
    expect(h.sent[0]!.text).toContain('http://web.test/projects/');
  });

  it('is reset by one passing check', async () => {
    const h = harness();
    await h.tick(h.workload('unhealthy'));
    await h.tick(h.workload('unhealthy'));
    await h.tick(h.workload('healthy'));
    await h.tick(h.workload('unhealthy'));
    await h.tick(h.workload('unhealthy'));
    expect(h.events).toHaveLength(0);
  });

  it('ignores checks that could not be made', async () => {
    const h = harness();
    for (let i = 0; i < 5; i++) await h.tick(h.workload('unknown'));
    expect(h.events).toHaveLength(0);
    expect(h.record.consecutiveFailures).toBe(0);
  });

  it('clears with a second email when the application answers again', async () => {
    const h = harness();
    for (let i = 0; i < 3; i++) await h.tick(h.workload('unhealthy'));
    await h.tick(h.workload('healthy'));
    await h.tick(h.workload('healthy'));

    expect(h.events.map((e) => e.state)).toEqual(['FIRING', 'RESOLVED']);
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1]!.subject).toContain('cleared');
  });

  it('closes an alert when the deployment is stopped, rather than leaving it firing', async () => {
    const h = harness();
    for (let i = 0; i < 3; i++) await h.tick(h.workload('unhealthy'));
    await h.tick(null);

    expect(h.events.at(-1)).toMatchObject({
      state: 'RESOLVED',
      message: 'The deployment was stopped.',
    });
    expect(h.record.healthFiring).toBe(false);
  });
});

describe('memory alerts', () => {
  it('starts at the threshold and clears only well below it', async () => {
    const h = harness({ memoryPercent: 80 });
    await h.tick(h.workload('healthy', 79));
    expect(h.events).toHaveLength(0);

    await h.tick(h.workload('healthy', 85));
    // Hovering just under the line does not clear it and start it again.
    await h.tick(h.workload('healthy', 78));
    await h.tick(h.workload('healthy', 81));
    expect(h.events.map((e) => e.state)).toEqual(['FIRING']);

    await h.tick(h.workload('healthy', 60));
    expect(h.events.map((e) => e.state)).toEqual(['FIRING', 'RESOLVED']);
  });

  it('says nothing when memory was not measured', async () => {
    const h = harness({ memoryPercent: 50 });
    await h.tick(h.workload('healthy'));
    expect(h.events).toHaveLength(0);
  });
});

describe('who is told', () => {
  it('records but does not email an owner whose address was never confirmed', async () => {
    const h = harness({ verified: false });
    for (let i = 0; i < 3; i++) await h.tick(h.workload('unhealthy'));
    expect(h.events).toEqual([expect.objectContaining({ state: 'FIRING', notified: false })]);
    expect(h.sent).toHaveLength(0);
  });

  it('records but does not claim to have emailed when there is no mail server', async () => {
    const h = harness({ mailDown: true });
    for (let i = 0; i < 3; i++) await h.tick(h.workload('unhealthy'));
    expect(h.events[0]!.notified).toBe(false);
    expect(h.sent).toHaveLength(0);
  });
});
