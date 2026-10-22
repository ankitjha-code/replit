import type { Logger } from 'pino';
import type { Database } from '../db/client.js';
import type { KeyRing } from '../lib/secret-box.js';

/**
 * Re-seals every stored secret with the current key.
 *
 * The second half of a rotation. The first half is configuration: the new key
 * becomes current and the old one moves to the previous list, so everything
 * keeps working. This makes it so the old key is no longer *needed* — and only
 * then can it be removed, which is the point of rotating a leaked key at all.
 *
 * ## What it touches
 *
 * Exactly two columns hold sealed values: a project secret's value and a
 * project database's password. Both are listed here by name. A third column
 * added later that this function did not know about would be left under the old
 * key and break when that key was removed, which is why the list is explicit
 * and why the command reports what it could not open rather than skipping it.
 *
 * ## Safe to run twice
 *
 * A value already sealed with the current key is left alone, so an interrupted
 * run can simply be run again.
 */

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

  /*
   * Two-factor secrets and git tokens are sealed with the same key. Missed by
   * the first version of this routine, which would have left every enrolled
   * account unable to sign in once the previous key was removed.
   */
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
