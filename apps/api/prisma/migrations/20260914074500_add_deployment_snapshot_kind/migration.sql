-- AlterEnum
-- The fixed version a deployment was built from. Added rather than reusing
-- AUTOMATIC because automatic snapshots are pruned, and pruning the copy a
-- running deployment was built from would lose the answer to what is running.
ALTER TYPE "SnapshotKind" ADD VALUE 'DEPLOYMENT';
