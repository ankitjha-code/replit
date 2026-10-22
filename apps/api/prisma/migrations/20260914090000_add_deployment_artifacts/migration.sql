-- AlterTable
-- What the build printed, where the built site is stored, and the port a server
-- deployment answered on. All nullable: an existing deployment has none of them,
-- and a static deployment never has a container port.
ALTER TABLE "deployments"
  ADD COLUMN "containerPort" INTEGER,
  ADD COLUMN "buildLog" TEXT,
  ADD COLUMN "buildLogTruncated" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "artifactKey" VARCHAR(255),
  ADD COLUMN "artifactBytes" INTEGER,
  ADD COLUMN "fileCount" INTEGER;

-- CreateIndex
-- One deployment per stored object. A key pointed at by two rows would let one
-- deployment's removal take another's site away.
CREATE UNIQUE INDEX "deployments_artifactKey_key" ON "deployments"("artifactKey");
