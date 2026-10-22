-- CreateTable
CREATE TABLE "project_assets" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "storageKey" VARCHAR(255) NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "contentType" VARCHAR(255) NOT NULL,
    "size" INTEGER NOT NULL,
    "checksum" CHAR(64) NOT NULL,
    "uploadedById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_assets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "project_assets_storageKey_key" ON "project_assets"("storageKey");

-- CreateIndex
CREATE INDEX "project_assets_projectId_createdAt_idx" ON "project_assets"("projectId", "createdAt");

-- AddForeignKey
ALTER TABLE "project_assets" ADD CONSTRAINT "project_assets_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_assets" ADD CONSTRAINT "project_assets_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
