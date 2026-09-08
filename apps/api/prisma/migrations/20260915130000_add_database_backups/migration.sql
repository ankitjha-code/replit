-- Backups of a project's own database.
--
-- The row is bookkeeping; the dump is an object in storage, like a snapshot or
-- a repository archive. A copy of somebody's data does not belong in the
-- control plane's tables.

CREATE TYPE "backup_status" AS ENUM ('RUNNING', 'READY', 'FAILED');

CREATE TABLE "project_database_backups" (
  "id" UUID NOT NULL,
  "databaseId" UUID NOT NULL,
  -- Denormalised so backups can be listed and authorized without joining
  -- through the database row, and so they cascade with the project.
  "projectId" UUID NOT NULL,
  "status" "backup_status" NOT NULL DEFAULT 'RUNNING',
  "note" VARCHAR(200),
  "storageKey" VARCHAR(255),
  "sizeBytes" INTEGER,
  "message" VARCHAR(500),
  "createdById" UUID,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMPTZ(3),

  CONSTRAINT "project_database_backups_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "project_database_backups_storageKey_key"
  ON "project_database_backups"("storageKey");
CREATE INDEX "project_database_backups_projectId_createdAt_idx"
  ON "project_database_backups"("projectId", "createdAt");

ALTER TABLE "project_database_backups"
  ADD CONSTRAINT "project_database_backups_databaseId_fkey"
  FOREIGN KEY ("databaseId") REFERENCES "project_databases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "project_database_backups"
  ADD CONSTRAINT "project_database_backups_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Nulled rather than cascading: removing an account must not erase a project's
-- backup history.
ALTER TABLE "project_database_backups"
  ADD CONSTRAINT "project_database_backups_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
