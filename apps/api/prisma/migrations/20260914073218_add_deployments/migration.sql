-- CreateEnum
CREATE TYPE "deployment_status" AS ENUM ('REQUESTED', 'BUILDING', 'STARTING', 'RUNNING', 'STOPPING', 'STOPPED', 'FAILED');

-- CreateEnum
CREATE TYPE "deployment_target" AS ENUM ('STATIC', 'SERVER');

-- CreateTable
CREATE TABLE "deployments" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "status" "deployment_status" NOT NULL DEFAULT 'REQUESTED',
    "target" "deployment_target" NOT NULL,
    "note" VARCHAR(200),
    "buildCommand" VARCHAR(2000),
    "outputDirectory" VARCHAR(200),
    "startCommand" VARCHAR(2000),
    "snapshotId" UUID,
    "provider" VARCHAR(32),
    "externalId" VARCHAR(128),
    "url" VARCHAR(500),
    "message" VARCHAR(500),
    "revision" INTEGER NOT NULL DEFAULT 0,
    "requestedById" UUID,
    "statusChangedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMPTZ(3),
    "stoppedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "deployments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deployment_events" (
    "id" UUID NOT NULL,
    "deploymentId" UUID NOT NULL,
    "fromStatus" "deployment_status",
    "toStatus" "deployment_status" NOT NULL,
    "reason" VARCHAR(500),
    "actorId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deployment_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_deployment_configs" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "target" "deployment_target" NOT NULL,
    "buildCommand" VARCHAR(2000),
    "outputDirectory" VARCHAR(200),
    "startCommand" VARCHAR(2000),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "project_deployment_configs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "deployments_projectId_createdAt_idx" ON "deployments"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "deployments_status_idx" ON "deployments"("status");

-- CreateIndex
CREATE INDEX "deployment_events_deploymentId_createdAt_idx" ON "deployment_events"("deploymentId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "project_deployment_configs_projectId_key" ON "project_deployment_configs"("projectId");

-- AddForeignKey
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "project_snapshots"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deployment_events" ADD CONSTRAINT "deployment_events_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "deployments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_deployment_configs" ADD CONSTRAINT "project_deployment_configs_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
