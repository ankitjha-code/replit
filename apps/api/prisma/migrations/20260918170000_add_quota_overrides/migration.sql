-- An operator's per-account ceilings. No row means the installation default.
CREATE TABLE "account_quota_overrides" (
    "userId" UUID NOT NULL,
    "kind" VARCHAR(32) NOT NULL,
    "limit" INTEGER NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "account_quota_overrides_pkey" PRIMARY KEY ("userId", "kind"),
    CONSTRAINT "account_quota_overrides_kind_check" CHECK ("kind" IN ('RUNTIMES', 'DEPLOYMENTS', 'BUILDS')),
    CONSTRAINT "account_quota_overrides_limit_check" CHECK ("limit" > 0)
);

ALTER TABLE "account_quota_overrides" ADD CONSTRAINT "account_quota_overrides_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
