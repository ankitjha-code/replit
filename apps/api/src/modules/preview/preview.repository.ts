import type { Database } from '../../db/client.js';

/**
 * The only code that reads or writes preview grants and share links.
 *
 * Shaped like the session repository, because a grant is the same kind of
 * thing: an opaque token the browser holds and the server knows only as a
 * hash. A share link is one more of those, held by whoever it was sent to.
 */

export interface PreviewGrantRecord {
  id: string;
  projectId: string;
  /** Null for a viewer who came in through a share link. */
  userId: string | null;
  shareId: string | null;
  expiresAt: Date;
  createdAt: Date;
}

export interface PreviewShareRecord {
  id: string;
  projectId: string;
  label: string | null;
  expiresAt: Date;
  revokedAt: Date | null;
  createdAt: Date;
  createdBy: { username: string } | null;
}

const GRANT_FIELDS = {
  id: true,
  projectId: true,
  userId: true,
  shareId: true,
  expiresAt: true,
  createdAt: true,
} as const;

const SHARE_FIELDS = {
  id: true,
  projectId: true,
  label: true,
  expiresAt: true,
  revokedAt: true,
  createdAt: true,
  createdBy: { select: { username: true } },
} as const;

export class PreviewGrantRepository {
  constructor(private readonly db: Database) {}

  create(input: {
    projectId: string;
    userId: string | null;
    shareId?: string | null;
    tokenHash: string;
    expiresAt: Date;
  }): Promise<PreviewGrantRecord> {
    return this.db.previewGrant.create({ data: input, select: GRANT_FIELDS });
  }

  findByTokenHash(tokenHash: string): Promise<PreviewGrantRecord | null> {
    return this.db.previewGrant.findUnique({ where: { tokenHash }, select: GRANT_FIELDS });
  }

  deleteById(id: string): Promise<unknown> {
    return this.db.previewGrant.deleteMany({ where: { id } });
  }

  /** Housekeeping. Expired grants are useless and accumulate. */
  deleteExpired(now: Date): Promise<{ count: number }> {
    return this.db.previewGrant.deleteMany({ where: { expiresAt: { lt: now } } });
  }

  // --- Share links ----------------------------------------------------------

  createShare(input: {
    projectId: string;
    createdById: string;
    tokenHash: string;
    label: string | null;
    expiresAt: Date;
  }): Promise<PreviewShareRecord> {
    return this.db.previewShare.create({ data: input, select: SHARE_FIELDS });
  }

  findShareByTokenHash(tokenHash: string): Promise<PreviewShareRecord | null> {
    return this.db.previewShare.findUnique({ where: { tokenHash }, select: SHARE_FIELDS });
  }

  findShare(id: string): Promise<PreviewShareRecord | null> {
    return this.db.previewShare.findUnique({ where: { id }, select: SHARE_FIELDS });
  }

  listShares(projectId: string): Promise<PreviewShareRecord[]> {
    return this.db.previewShare.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: SHARE_FIELDS,
    });
  }

  /** Revokes a link, scoped to its project, and removes every viewing it granted. */
  async revokeShare(projectId: string, id: string): Promise<boolean> {
    const result = await this.db.previewShare.updateMany({
      where: { id, projectId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await this.db.previewGrant.deleteMany({ where: { shareId: id } });
    return result.count === 1;
  }
}
