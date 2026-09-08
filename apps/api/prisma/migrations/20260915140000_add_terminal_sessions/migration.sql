-- Terminals that can be found again after the control plane restarts.
--
-- The row is not the shell: the shell is a process inside the container, which
-- is what makes surviving possible. This records that it is there, whose it is,
-- and which container to look in.

CREATE TABLE "project_terminal_sessions" (
  "id" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "runtimeId" UUID NOT NULL,
  -- False when the environment could not support a detached shell and the
  -- platform fell back to holding the stream. Recorded rather than inferred, so
  -- the interface never promises a resume that will fail.
  "durable" BOOLEAN NOT NULL DEFAULT true,
  "rows" INTEGER NOT NULL,
  "columns" INTEGER NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastActiveAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "project_terminal_sessions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "project_terminal_sessions_projectId_userId_idx"
  ON "project_terminal_sessions"("projectId", "userId");

ALTER TABLE "project_terminal_sessions"
  ADD CONSTRAINT "project_terminal_sessions_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "project_terminal_sessions"
  ADD CONSTRAINT "project_terminal_sessions_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Cascades with the runtime: the shell lives in that container, so a runtime
-- that is gone takes every terminal in it.
ALTER TABLE "project_terminal_sessions"
  ADD CONSTRAINT "project_terminal_sessions_runtimeId_fkey"
  FOREIGN KEY ("runtimeId") REFERENCES "runtimes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
