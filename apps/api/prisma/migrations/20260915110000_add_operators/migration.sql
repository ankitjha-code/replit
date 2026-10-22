-- Platform operators.
--
-- False for every existing account, which is correct: an installation must not
-- acquire an operator by being upgraded. The first one is granted from the
-- machine with `pnpm --filter @platform/api operator:grant <email>`, which is
-- the honest boundary — being able to make an operator should require the same
-- access as being able to edit the database directly, because it is equivalent.
ALTER TABLE "users" ADD COLUMN "isOperator" BOOLEAN NOT NULL DEFAULT false;
