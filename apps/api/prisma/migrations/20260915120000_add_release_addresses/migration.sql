-- Per-release addresses, and rollback as a first-class thing that happened.
--
-- Null for every existing deployment: they were made before releases had their
-- own addresses, and inventing labels for them would make URLs that were never
-- published look like they had been.

ALTER TABLE "deployments" ADD COLUMN "releaseLabel" VARCHAR(32);
ALTER TABLE "deployments" ADD COLUMN "rolledBackFromId" UUID;

CREATE UNIQUE INDEX "deployments_releaseLabel_key" ON "deployments"("releaseLabel");

-- SET NULL rather than CASCADE. Deleting an old release must not delete the one
-- that rolled back to it, which is very likely the release that is live.
ALTER TABLE "deployments"
  ADD CONSTRAINT "deployments_rolledBackFromId_fkey"
  FOREIGN KEY ("rolledBackFromId") REFERENCES "deployments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
