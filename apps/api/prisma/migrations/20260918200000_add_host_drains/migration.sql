-- Hosts an operator has taken out of placement.
CREATE TABLE "execution_host_drains" (
    "hostName" VARCHAR(32) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "execution_host_drains_pkey" PRIMARY KEY ("hostName")
);
