-- AlterEnum
-- A job type is a value in this enum and a key in the platform's own table of
-- payload schemas, and the two have to be the same string: a mapping between
-- them would be a third place for the set to drift, in the one table where a
-- value the platform cannot decode is a row that never finishes.
--
-- Renamed rather than recreated, so existing rows keep their meaning.
ALTER TYPE "job_type" RENAME VALUE 'runtime.start' TO 'RUNTIME_START';
ALTER TYPE "job_type" RENAME VALUE 'deployment.build' TO 'DEPLOYMENT_BUILD';
