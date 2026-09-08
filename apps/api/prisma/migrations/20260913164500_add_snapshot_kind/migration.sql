-- CreateEnum
CREATE TYPE "SnapshotKind" AS ENUM ('MANUAL', 'AUTOMATIC');

-- AlterTable
-- Existing snapshots were all taken by a person, so MANUAL is not merely the
-- default: it is what every row already in this table actually is.
ALTER TABLE "project_snapshots" ADD COLUMN "kind" "SnapshotKind" NOT NULL DEFAULT 'MANUAL';

-- CreateIndex
CREATE INDEX "project_snapshots_projectId_kind_createdAt_idx" ON "project_snapshots"("projectId", "kind", "createdAt");
