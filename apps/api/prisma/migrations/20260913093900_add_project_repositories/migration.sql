-- CreateTable
CREATE TABLE "project_repositories" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "storageKey" VARCHAR(255) NOT NULL,
    "branch" VARCHAR(255) NOT NULL DEFAULT 'main',
    "headOid" CHAR(40),
    "checksum" CHAR(64) NOT NULL,
    "sizeBytes" INTEGER NOT NULL DEFAULT 0,
    "commitCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "project_repositories_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "project_repositories_projectId_key" ON "project_repositories"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "project_repositories_storageKey_key" ON "project_repositories"("storageKey");

-- AddForeignKey
ALTER TABLE "project_repositories" ADD CONSTRAINT "project_repositories_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
