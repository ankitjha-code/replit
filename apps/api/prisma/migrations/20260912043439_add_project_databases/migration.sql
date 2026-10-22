-- CreateEnum
CREATE TYPE "database_status" AS ENUM ('CREATING', 'READY', 'FAILED');

-- CreateTable
CREATE TABLE "project_databases" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "status" "database_status" NOT NULL DEFAULT 'CREATING',
    "name" VARCHAR(63) NOT NULL,
    "role" VARCHAR(63) NOT NULL,
    "password" BYTEA NOT NULL,
    "message" VARCHAR(500),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "project_databases_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "project_databases_projectId_key" ON "project_databases"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "project_databases_name_key" ON "project_databases"("name");

-- CreateIndex
CREATE UNIQUE INDEX "project_databases_role_key" ON "project_databases"("role");

-- AddForeignKey
ALTER TABLE "project_databases" ADD CONSTRAINT "project_databases_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
