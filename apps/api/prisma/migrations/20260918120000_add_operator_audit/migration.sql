-- What operators did, kept in a table rather than in log lines.
--
-- Only ever inserted into. Nothing in the platform updates or deletes a row, so
-- the record cannot be tidied by the people it records.

CREATE TABLE "operator_audit_entries" (
  "id" UUID NOT NULL,
  "actorId" UUID,
  "actorName" VARCHAR(39) NOT NULL,
  "action" VARCHAR(64) NOT NULL,
  "targetId" UUID,
  "targetName" VARCHAR(39),
  "detail" JSONB,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "operator_audit_entries_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "operator_audit_entries_createdAt_idx" ON "operator_audit_entries"("createdAt");

-- Nulled rather than cascading: closing an operator's account must not erase
-- what they did.
ALTER TABLE "operator_audit_entries"
  ADD CONSTRAINT "operator_audit_entries_actorId_fkey"
  FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
