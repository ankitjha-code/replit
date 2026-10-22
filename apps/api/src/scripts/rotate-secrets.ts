import { loadDotEnv } from '../config/dotenv.js';
import { env } from '../config/env.js';
import { createDatabase } from '../db/client.js';
import { rotateSecrets } from '../lifecycle/rotate-secrets.js';
import { createKeyRing, parseEncryptionKey, parsePreviousKeys } from '../lib/secret-box.js';
import { logger } from '../lib/logger.js';

/**
 * Re-seals every stored secret with the current encryption key.
 *
 * A rotation, start to finish:
 *
 *   1. Generate a new key.
 *   2. Put it in SECRETS_ENCRYPTION_KEY, and move the old one to
 *      SECRETS_PREVIOUS_KEYS. Restart. Everything keeps working.
 *   3. Run this:  pnpm --filter @platform/api secrets:rotate
 *   4. When it reports nothing unreadable, remove SECRETS_PREVIOUS_KEYS.
 *
 * A command on the machine rather than an endpoint, like granting the first
 * operator: it needs both keys, and both keys only exist in the machine's
 * configuration. An endpoint could not do anything the configuration had not
 * already made possible.
 */
async function main(): Promise<void> {
  loadDotEnv();
  const config = env();

  const current = parseEncryptionKey(config.SECRETS_ENCRYPTION_KEY);
  if (!current) {
    console.error('SECRETS_ENCRYPTION_KEY is not set, so there is nothing to rotate to.');
    process.exit(1);
  }
  if (!config.DATABASE_URL) {
    console.error('DATABASE_URL is not set.');
    process.exit(1);
  }

  const ring = createKeyRing(current, parsePreviousKeys(config.SECRETS_PREVIOUS_KEYS));
  const database = createDatabase(config, logger());
  await database.connect();

  try {
    const report = await rotateSecrets(database.client, ring, logger());
    console.log(JSON.stringify(report, null, 2));

    const unreadable =
      report.secrets.unreadable +
      report.databases.unreadable +
      report.twoFactor.unreadable +
      report.gitRemotes.unreadable;
    if (unreadable > 0) {
      console.error(
        `${String(unreadable)} value(s) could not be opened with any configured key. Do not remove SECRETS_PREVIOUS_KEYS until they are accounted for.`,
      );
      process.exit(2);
    }

    console.log(
      'Every stored secret is sealed with the current key. SECRETS_PREVIOUS_KEYS can be removed.',
    );
  } finally {
    await database.disconnect();
  }
}

main().catch((error: unknown) => {
  console.error('Rotation failed:', error);
  process.exit(1);
});
