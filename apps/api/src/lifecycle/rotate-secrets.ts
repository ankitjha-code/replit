import type { Logger } from 'pino';
import type { Database } from '../db/client.js';
import type { KeyRing } from '../lib/secret-box.js';

export interface RotationReport {
  secrets: { resealed: number; alreadyCurrent: number; unreadable: number };
  databases: { resealed: number; alreadyCurrent: number; unreadable: number };
  twoFactor: { resealed: number; alreadyCurrent: number; unreadable: number };
  gitRemotes: { resealed: number; alreadyCurrent: number; unreadable: number };
}

export async function rotateSecrets(
  db: Database,
  ring: KeyRing,
  log: Logger,
): Promise<RotationReport> {
  const report: RotationReport = {
    secrets: { resealed: 0, alreadyCurrent: 0, unreadable: 0 },
    databases: { resealed: 0, alreadyCurrent: 0, unreadable: 0 },
    twoFactor: { resealed: 0, alreadyCurrent: 0, unreadable: 0 },
    gitRemotes: { resealed: 0, alreadyCurrent: 0, unreadable: 0 },
  };

  for (const row of await db.projectSecret.findMany({ select: { id: true, value: true } })) {
    const outcome = reseal(ring, row.value);
    report.secrets[outcome.kind] += 1;
    if (outcome.kind === 'resealed') {
      await db.projectSecret.update({ where: { id: row.id }, data: { value: outcome.value } });
    } else if (outcome.kind === 'unreadable') {
      log.error({ secretId: row.id }, 'a secret could not be opened with any configured key');
    }
  }

  for (const row of await db.projectDatabase.findMany({ select: { id: true, password: true } })) {
    const outcome = reseal(ring, row.password);
    report.databases[outcome.kind] += 1;
    if (outcome.kind === 'resealed') {
      await db.projectDatabase.update({ where: { id: row.id }, data: { password: outcome.value } });
    } else if (outcome.kind === 'unreadable') {
      log.error(
        { databaseId: row.id },
        'a database password could not be opened with any configured key',
      );
    }
  }

  for (const row of await db.user.findMany({
    where: { totpSecret: { not: null } },
    select: { id: true, totpSecret: true },
  })) {
    const outcome = reseal(ring, row.totpSecret!);
    report.twoFactor[outcome.kind] += 1;
    if (outcome.kind === 'resealed') {
      await db.user.update({ where: { id: row.id }, data: { totpSecret: outcome.value } });
    } else if (outcome.kind === 'unreadable') {
      log.error(
        { userId: row.id },
        'a two-factor secret could not be opened with any configured key',
      );
    }
  }

  for (const row of await db.projectGitRemote.findMany({
    where: { token: { not: null } },
    select: { projectId: true, token: true },
  })) {
    const outcome = reseal(ring, row.token!);
    report.gitRemotes[outcome.kind] += 1;
    if (outcome.kind === 'resealed') {
      await db.projectGitRemote.update({
        where: { projectId: row.projectId },
        data: { token: outcome.value },
      });
    } else if (outcome.kind === 'unreadable') {
      log.error(
        { projectId: row.projectId },
        'a git token could not be opened with any configured key',
      );
    }
  }

  return report;
}

function reseal(
  ring: KeyRing,
  sealed: Uint8Array,
):
  | { kind: 'alreadyCurrent' }
  | { kind: 'unreadable' }
  | { kind: 'resealed'; value: Uint8Array<ArrayBuffer> } {
  if (ring.isCurrent(sealed)) return { kind: 'alreadyCurrent' };

  let plaintext: string;
  try {
    plaintext = ring.open(sealed);
  } catch {
    return { kind: 'unreadable' };
  }

  return { kind: 'resealed', value: new Uint8Array(ring.seal(plaintext)) };
}
