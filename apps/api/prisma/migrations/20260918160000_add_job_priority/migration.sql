-- Work somebody is waiting for goes ahead of work nobody is watching.
ALTER TABLE "jobs" ADD COLUMN "priority" INTEGER NOT NULL DEFAULT 0;

-- The claim now orders by priority first; the old index no longer matches it.
DROP INDEX IF EXISTS "jobs_status_scheduledAt_idx";
CREATE INDEX "jobs_status_priority_scheduledAt_idx" ON "jobs"("status", "priority" DESC, "scheduledAt");
