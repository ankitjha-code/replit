-- Per-project alerting on a deployment's health and memory.
CREATE TABLE "project_alert_settings" (
    "projectId" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "failuresBeforeAlert" INTEGER NOT NULL DEFAULT 3,
    "memoryPercent" INTEGER,
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "healthFiring" BOOLEAN NOT NULL DEFAULT false,
    "memoryFiring" BOOLEAN NOT NULL DEFAULT false,
    "lastCheckedAt" TIMESTAMPTZ(3),
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "project_alert_settings_pkey" PRIMARY KEY ("projectId"),
    CONSTRAINT "project_alert_settings_failures_check" CHECK ("failuresBeforeAlert" BETWEEN 1 AND 20),
    CONSTRAINT "project_alert_settings_memory_check" CHECK ("memoryPercent" IS NULL OR "memoryPercent" BETWEEN 50 AND 100)
);

CREATE INDEX "project_alert_settings_enabled_lastCheckedAt_idx" ON "project_alert_settings"("enabled", "lastCheckedAt");

ALTER TABLE "project_alert_settings" ADD CONSTRAINT "project_alert_settings_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "project_alert_events" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "kind" VARCHAR(16) NOT NULL,
    "state" VARCHAR(16) NOT NULL,
    "message" VARCHAR(500) NOT NULL,
    "notified" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_alert_events_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "project_alert_events_kind_check" CHECK ("kind" IN ('HEALTH', 'MEMORY')),
    CONSTRAINT "project_alert_events_state_check" CHECK ("state" IN ('FIRING', 'RESOLVED'))
);

CREATE INDEX "project_alert_events_projectId_createdAt_idx" ON "project_alert_events"("projectId", "createdAt");

ALTER TABLE "project_alert_events" ADD CONSTRAINT "project_alert_events_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
