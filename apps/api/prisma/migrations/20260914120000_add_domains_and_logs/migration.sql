-- CreateEnum
CREATE TYPE "domain_status" AS ENUM ('PENDING', 'VERIFIED', 'FAILED');

-- CreateEnum
CREATE TYPE "log_source" AS ENUM ('RUN', 'DEPLOYMENT');

-- AlterTable
-- The label a project's deployment answers on. Unique across the installation,
-- unlike the slug, which is unique only within an owner's account.
ALTER TABLE "projects" ADD COLUMN "deploymentSubdomain" VARCHAR(63);

-- CreateIndex
CREATE UNIQUE INDEX "projects_deploymentSubdomain_key" ON "projects"("deploymentSubdomain");

-- CreateTable
CREATE TABLE "project_domains" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "hostname" VARCHAR(253) NOT NULL,
    "status" "domain_status" NOT NULL DEFAULT 'PENDING',
    "verificationToken" VARCHAR(64) NOT NULL,
    "message" VARCHAR(500),
    "verifiedAt" TIMESTAMPTZ(3),
    "lastCheckedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "project_domains_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- One hostname resolves to one project. Two rows claiming it would make which
-- one an accident of query order.
CREATE UNIQUE INDEX "project_domains_hostname_key" ON "project_domains"("hostname");

-- CreateIndex
CREATE INDEX "project_domains_projectId_createdAt_idx" ON "project_domains"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "project_domains_status_lastCheckedAt_idx" ON "project_domains"("status", "lastCheckedAt");

-- CreateTable
CREATE TABLE "project_log_lines" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "source" "log_source" NOT NULL,
    "sourceId" VARCHAR(64) NOT NULL,
    "stream" VARCHAR(8) NOT NULL,
    "message" VARCHAR(2000) NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_log_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- Reading a project's log backwards, which is the only way one is read.
CREATE INDEX "project_log_lines_projectId_at_id_idx" ON "project_log_lines"("projectId", "at", "id");

-- CreateIndex
CREATE INDEX "project_log_lines_projectId_source_sourceId_at_idx" ON "project_log_lines"("projectId", "source", "sourceId", "at");

-- AddForeignKey
ALTER TABLE "project_domains" ADD CONSTRAINT "project_domains_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_log_lines" ADD CONSTRAINT "project_log_lines_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
