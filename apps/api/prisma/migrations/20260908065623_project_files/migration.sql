-- CreateEnum
CREATE TYPE "project_file_type" AS ENUM ('FILE', 'DIRECTORY');

-- CreateTable
CREATE TABLE "project_files" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "path" VARCHAR(1024) NOT NULL,
    "parentPath" VARCHAR(1024) NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "type" "project_file_type" NOT NULL,
    "content" BYTEA,
    "size" INTEGER NOT NULL DEFAULT 0,
    "checksum" CHAR(64),
    "isBinary" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "project_files_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "project_files_projectId_parentPath_idx" ON "project_files"("projectId", "parentPath");

-- CreateIndex
CREATE INDEX "project_files_projectId_path_idx" ON "project_files"("projectId", "path");

-- CreateIndex
CREATE UNIQUE INDEX "project_files_projectId_path_key" ON "project_files"("projectId", "path");

-- AddForeignKey
ALTER TABLE "project_files" ADD CONSTRAINT "project_files_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
