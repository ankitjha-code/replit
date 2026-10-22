import { defineConfig } from 'prisma/config';

/**
 * Prisma CLI configuration (migrations, introspection, studio).
 *
 * Configuration lives at the repository root but the CLI runs from this
 * package, so the file is loaded here. Node's loader leaves an already-set
 * variable alone, which is what lets a command-line override win:
 *
 *   DATABASE_URL=... pnpm db:deploy
 *
 * The running application does not use this file. It builds its own pool in
 * src/db/client.ts.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const rootEnv = resolve(import.meta.dirname, '../../.env');
if (existsSync(rootEnv)) {
  process.loadEnvFile(rootEnv);
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    // Resolved lazily so `prisma generate`, which needs no database, still
    // works on a machine that has never been configured. Commands that do
    // touch the database get an actionable message instead of a driver error.
    get url() {
      const value = process.env.DATABASE_URL;
      if (!value) {
        throw new Error(
          'DATABASE_URL is not set. Run `pnpm infra:up`, or copy .env.example to .env.',
        );
      }
      return value;
    },
  },
});
