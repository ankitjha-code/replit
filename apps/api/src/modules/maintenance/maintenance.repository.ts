import type { Database } from '../../db/client.js';

const CHUNK = 500;

export class MaintenanceRepository {
  constructor(private readonly db: Database) {}

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

  async deleteExpiredSessions(now: Date): Promise<number> {
    const result = await this.db.session.deleteMany({ where: { expiresAt: { lt: now } } });
    return result.count;
  }

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
