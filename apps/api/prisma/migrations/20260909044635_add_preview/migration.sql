-- AlterTable
ALTER TABLE "runtimes" ADD COLUMN     "previewPort" INTEGER;

-- CreateTable
CREATE TABLE "preview_grants" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "tokenHash" CHAR(64) NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "preview_grants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "preview_grants_tokenHash_key" ON "preview_grants"("tokenHash");

-- CreateIndex
CREATE INDEX "preview_grants_projectId_idx" ON "preview_grants"("projectId");

-- CreateIndex
CREATE INDEX "preview_grants_expiresAt_idx" ON "preview_grants"("expiresAt");

-- AddForeignKey
ALTER TABLE "preview_grants" ADD CONSTRAINT "preview_grants_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "preview_grants" ADD CONSTRAINT "preview_grants_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
