-- One remote per project. The token is sealed with the secrets key.
CREATE TABLE "project_git_remotes" (
    "projectId" UUID NOT NULL,
    "url" VARCHAR(500) NOT NULL,
    "username" VARCHAR(200),
    "token" BYTEA,
    "lastPushedAt" TIMESTAMPTZ(3),
    "lastPulledAt" TIMESTAMPTZ(3),
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "project_git_remotes_pkey" PRIMARY KEY ("projectId")
);

ALTER TABLE "project_git_remotes" ADD CONSTRAINT "project_git_remotes_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
