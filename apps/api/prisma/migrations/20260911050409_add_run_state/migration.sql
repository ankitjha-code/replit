-- CreateEnum
CREATE TYPE "run_status" AS ENUM ('IDLE', 'STARTING', 'RUNNING', 'EXITED', 'FAILED');

-- AlterTable
ALTER TABLE "projects" ADD COLUMN     "runCommand" VARCHAR(2000);

-- AlterTable
ALTER TABLE "runtimes" ADD COLUMN     "runCommand" VARCHAR(2000),
ADD COLUMN     "runExitCode" INTEGER,
ADD COLUMN     "runExitedAt" TIMESTAMPTZ(3),
ADD COLUMN     "runMessage" VARCHAR(500),
ADD COLUMN     "runStartedAt" TIMESTAMPTZ(3),
ADD COLUMN     "runStatus" "run_status" NOT NULL DEFAULT 'IDLE';
