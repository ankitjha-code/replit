-- Public, time-limited, revocable links to a project's preview.

CREATE TABLE "preview_shares" (
  "id" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "createdById" UUID,
  -- A hash of the token, never the token.
  "tokenHash" CHAR(64) NOT NULL,
  "label" VARCHAR(100),
  "expiresAt" TIMESTAMPTZ(3) NOT NULL,
  "revokedAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "preview_shares_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "preview_shares_tokenHash_key" ON "preview_shares"("tokenHash");
CREATE INDEX "preview_shares_projectId_createdAt_idx" ON "preview_shares"("projectId", "createdAt");

ALTER TABLE "preview_shares"
  ADD CONSTRAINT "preview_shares_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "preview_shares"
  ADD CONSTRAINT "preview_shares_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- A viewing that came through a share has no account behind it.
ALTER TABLE "preview_grants" ALTER COLUMN "userId" DROP NOT NULL;
ALTER TABLE "preview_grants" ADD COLUMN "shareId" UUID;
ALTER TABLE "preview_grants"
  ADD CONSTRAINT "preview_grants_shareId_fkey"
  FOREIGN KEY ("shareId") REFERENCES "preview_shares"("id") ON DELETE CASCADE ON UPDATE CASCADE;
