-- AlterTable
-- How a project's own application is checked. On the project rather than on a
-- deployment: the same path is the right one to ask for in the workspace and in
-- production. Null means the default, so a project that has never thought about
-- it is not carrying a stored answer that only happens to match.
ALTER TABLE "projects"
  ADD COLUMN "healthCheckPath" VARCHAR(200),
  ADD COLUMN "healthCheckTimeoutMs" INTEGER;
