import type { Database } from '../../db/client.js';

/**
 * The only code that asks the database what still exists.
 *
 * Every query here is the same shape: given identifiers found **outside** the
 * platform's records, say which of them the platform still knows about. That
 * direction is deliberate and is the safety property the whole sweep rests on —
 * nothing here reads a row in order to delete something, it reads rows in order
 * to decide what may be left alone.
 *
 * Identifiers arrive in lists that are as long as whatever a machine is
 * holding, so every query is chunked. A single `IN` list of ten thousand values
 * is a statement Postgres will plan badly and some drivers will refuse
 * outright.
 */

/** Values per query. Comfortably under any parameter ceiling, and plans well. */
const CHUNK = 500;

export class MaintenanceRepository {
  constructor(private readonly db: Database) {}

  /** Which of these runtime rows are still there, and what each points at. */
  async runtimeExternalIds(ids: readonly string[]): Promise<Map<string, string | null>> {
    const found = new Map<string, string | null>();

    for (const chunk of chunks(ids)) {
      const rows = await this.db.runtime.findMany({
        where: { id: { in: chunk } },
        select: { id: true, externalId: true },
      });
      for (const row of rows) found.set(row.id, row.externalId);
    }

    return found;
  }

  async deploymentExternalIds(ids: readonly string[]): Promise<Map<string, string | null>> {
    const found = new Map<string, string | null>();

    for (const chunk of chunks(ids)) {
      const rows = await this.db.deployment.findMany({
        where: { id: { in: chunk } },
        select: { id: true, externalId: true },
      });
      for (const row of rows) found.set(row.id, row.externalId);
    }

    return found;
  }

  /** Which of these projects still exist. */
  async existingProjectIds(ids: readonly string[]): Promise<Set<string>> {
    const found = new Set<string>();

    for (const chunk of chunks(ids)) {
      const rows = await this.db.project.findMany({
        where: { id: { in: chunk } },
        select: { id: true },
      });
      for (const row of rows) found.add(row.id);
    }

    return found;
  }

  /**
   * Which of these stored objects are still referenced by something.
   *
   * Three tables, because three kinds of row hold a storage key and an object
   * is referenced if **any** of them names it. Asking one at a time and
   * combining would be the same work; asking only one would delete the other
   * two kinds.
   */
  async referencedStorageKeys(keys: readonly string[]): Promise<Set<string>> {
    const found = new Set<string>();

    for (const chunk of chunks(keys)) {
      const [snapshots, repositories, assets] = await Promise.all([
        this.db.projectSnapshot.findMany({
          where: { storageKey: { in: chunk } },
          select: { storageKey: true },
        }),
        this.db.projectRepository.findMany({
          where: { storageKey: { in: chunk } },
          select: { storageKey: true },
        }),
        this.db.projectAsset.findMany({
          where: { storageKey: { in: chunk } },
          select: { storageKey: true },
        }),
      ]);

      for (const row of [...snapshots, ...repositories, ...assets]) found.add(row.storageKey);
    }

    return found;
  }

  /** Which of these physical database names the platform still has a row for. */
  async existingDatabaseNames(names: readonly string[]): Promise<Set<string>> {
    const found = new Set<string>();

    for (const chunk of chunks(names)) {
      const rows = await this.db.projectDatabase.findMany({
        where: { name: { in: chunk } },
        select: { name: true },
      });
      for (const row of rows) found.add(row.name);
    }

    return found;
  }

  /**
   * Removes sessions past their absolute expiry.
   *
   * The one piece of cleanup here that needs no comparison with the outside
   * world: an expired session is already refused on every request, and the row
   * is only still there because nothing had a reason to delete it.
   */
  async deleteExpiredSessions(now: Date): Promise<number> {
    const result = await this.db.session.deleteMany({ where: { expiresAt: { lt: now } } });
    return result.count;
  }

  /**
   * Removes verification and reset links that are past their expiry.
   *
   * The same kind of cleanup as sessions and for the same reason: an expired
   * token is already refused, and the row is only still there because nothing
   * had a reason to delete it. Used ones go too once expired — the "already
   * used" message is only worth giving while the link could plausibly still be
   * in somebody's hand.
   */
  async deleteExpiredTokens(now: Date): Promise<number> {
    const result = await this.db.accountToken.deleteMany({ where: { expiresAt: { lt: now } } });
    return result.count;
  }
}

function* chunks(values: readonly string[]): Generator<string[]> {
  for (let index = 0; index < values.length; index += CHUNK) {
    yield values.slice(index, index + CHUNK);
  }
}
