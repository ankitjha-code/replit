-- AlterTable
-- Which machine a workload was placed on. Recorded separately from the opaque
-- identifier that also carries it, because this is what the scheduler counts:
-- working out what is on each host by parsing an opaque column would make that
-- encoding something the whole platform depended on.
--
-- Null for anything created before there was more than one host, which is what
-- lets an installation add a second one without every running container
-- becoming unreachable.
ALTER TABLE "runtimes" ADD COLUMN "executionHost" VARCHAR(32);
ALTER TABLE "deployments" ADD COLUMN "executionHost" VARCHAR(32);
