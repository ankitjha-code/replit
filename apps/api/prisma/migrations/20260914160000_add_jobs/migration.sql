-- CreateEnum
CREATE TYPE "job_type" AS ENUM ('runtime.start', 'deployment.build');

-- CreateEnum
CREATE TYPE "job_status" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED');

-- CreateTable
-- The row is the job. The queue beside it carries only a nudge; a worker that
-- missed one finds the same work by looking.
CREATE TABLE "jobs" (
    "id" UUID NOT NULL,
    "projectId" UUID,
    "type" "job_type" NOT NULL,
    "status" "job_status" NOT NULL DEFAULT 'QUEUED',
    "payload" JSONB NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "lastError" VARCHAR(1000),
    "scheduledAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMPTZ(3),
    "finishedAt" TIMESTAMPTZ(3),
    "lockedBy" VARCHAR(64),
    "lockedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- Claiming the next piece of work, which is the query that has to be fast.
CREATE INDEX "jobs_status_scheduledAt_idx" ON "jobs"("status", "scheduledAt");

-- CreateIndex
CREATE INDEX "jobs_projectId_createdAt_idx" ON "jobs"("projectId", "createdAt");

-- AddForeignKey
-- A deleted project's outstanding work is work nobody wants any more.
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
