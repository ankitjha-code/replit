-- Two-factor sign-in: a TOTP secret per account, recovery codes, and a
-- short-lived sign-in challenge between the password and the code.

ALTER TYPE "account_token_kind" ADD VALUE 'LOGIN_CHALLENGE';

ALTER TABLE "users" ADD COLUMN "totpSecret" BYTEA;
ALTER TABLE "users" ADD COLUMN "totpEnabledAt" TIMESTAMPTZ(3);
ALTER TABLE "users" ADD COLUMN "totpLastStep" INTEGER;

ALTER TABLE "account_tokens" ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "totp_recovery_codes" (
  "id" UUID NOT NULL,
  "userId" UUID NOT NULL,
  -- A hash, never the code. Shown once when generated.
  "codeHash" CHAR(64) NOT NULL,
  "usedAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "totp_recovery_codes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "totp_recovery_codes_codeHash_key" ON "totp_recovery_codes"("codeHash");
CREATE INDEX "totp_recovery_codes_userId_idx" ON "totp_recovery_codes"("userId");

ALTER TABLE "totp_recovery_codes"
  ADD CONSTRAINT "totp_recovery_codes_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
