-- Address verification and password reset.
--
-- Written by hand, like every migration here: `prisma migrate dev` is
-- interactive and cannot run in this environment.

CREATE TYPE "account_token_kind" AS ENUM ('EMAIL_VERIFICATION', 'PASSWORD_RESET');

-- Null for every account that already exists, which is correct: none of them
-- has proved its address, because until now there was no way to.
ALTER TABLE "users" ADD COLUMN "emailVerifiedAt" TIMESTAMPTZ(3);

CREATE TABLE "account_tokens" (
  "id" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "kind" "account_token_kind" NOT NULL,
  -- The hash, never the token. A dump of this table must not be replayable.
  "tokenHash" CHAR(64) NOT NULL,
  -- The address it was sent to, so a verification proves that address and not
  -- whatever the account says now.
  "email" VARCHAR(320) NOT NULL,
  "expiresAt" TIMESTAMPTZ(3) NOT NULL,
  "usedAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "account_tokens_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "account_tokens_tokenHash_key" ON "account_tokens"("tokenHash");
CREATE INDEX "account_tokens_userId_kind_idx" ON "account_tokens"("userId", "kind");
CREATE INDEX "account_tokens_expiresAt_idx" ON "account_tokens"("expiresAt");

ALTER TABLE "account_tokens"
  ADD CONSTRAINT "account_tokens_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
