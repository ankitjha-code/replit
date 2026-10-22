import { defineConfig } from 'prisma/config';

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
