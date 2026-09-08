-- Noticing a verified domain that has stopped pointing here.
--
-- Counted, not acted on at once: DNS has bad minutes, and one failed lookup
-- must not take somebody's site down.
ALTER TABLE "project_domains" ADD COLUMN "consecutiveMisses" INTEGER NOT NULL DEFAULT 0;
