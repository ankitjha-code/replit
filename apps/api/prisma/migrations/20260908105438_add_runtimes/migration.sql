-- CreateEnum
CREATE TYPE "runtime_status" AS ENUM ('REQUESTED', 'CREATING', 'STARTING', 'RUNNING', 'STOPPING', 'STOPPED', 'FAILED');

-- CreateTable
CREATE TABLE "runtimes" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "status" "runtime_status" NOT NULL DEFAULT 'REQUESTED',
    "provider" VARCHAR(32) NOT NULL,
    "externalId" VARCHAR(128),
    "language" VARCHAR(32) NOT NULL,
    "version" VARCHAR(32) NOT NULL,
    "image" VARCHAR(200) NOT NULL,
    "cpuMillicores" INTEGER NOT NULL,
    "memoryMb" INTEGER NOT NULL,
    "pidsLimit" INTEGER NOT NULL,
    "message" VARCHAR(500),
    "revision" INTEGER NOT NULL DEFAULT 0,
    "requestedById" UUID,
    "statusChangedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMPTZ(3),
    "stoppedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "runtimes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "runtime_events" (
    "id" UUID NOT NULL,
    "runtimeId" UUID NOT NULL,
    "fromStatus" "runtime_status",
    "toStatus" "runtime_status" NOT NULL,
    "reason" VARCHAR(500),
    "actorId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "runtime_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "runtimes_projectId_key" ON "runtimes"("projectId");

-- CreateIndex
CREATE INDEX "runtimes_status_idx" ON "runtimes"("status");

-- CreateIndex
CREATE INDEX "runtime_events_runtimeId_createdAt_idx" ON "runtime_events"("runtimeId", "createdAt");

-- AddForeignKey
ALTER TABLE "runtimes" ADD CONSTRAINT "runtimes_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "runtimes" ADD CONSTRAINT "runtimes_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "runtime_events" ADD CONSTRAINT "runtime_events_runtimeId_fkey" FOREIGN KEY ("runtimeId") REFERENCES "runtimes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
