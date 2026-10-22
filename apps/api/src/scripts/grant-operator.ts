import { createDatabase } from '../db/client.js';
import { loadDotEnv } from '../config/dotenv.js';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

/**
 * Grants or removes operator access, from the machine.
 *
 * ## Why this is a script and not an endpoint
 *
 * The first operator on an installation has to come from somewhere, and every
 * option except this one is worse:
 *
 *  - **The first account to register**, which makes signing up first a race
 *    worth winning and is invisible afterwards.
 *  - **An address in configuration**, which means an environment variable that
 *    silently grants access to whoever controls that mailbox, and which nobody
 *    remembers is set.
 *  - **A setup wizard**, which is an unauthenticated endpoint that grants
 *    total access and must be disabled afterwards by somebody remembering to.
 *
 * Running this needs shell access to the machine and the database URL — which
 * is the same access as editing the row directly. Nothing is being protected by
 * making it awkward; the point is that the boundary is honest about what it is.
 *
 * Every operator after the first can be made by an operator, through the
 * ordinary surface, where it is logged with who did it.
 *
 *   pnpm --filter @platform/api operator:grant somebody@example.com
 *   pnpm --filter @platform/api operator:grant somebody@example.com --revoke
 */
async function main(): Promise<void> {
  loadDotEnv();
  const config = env();

  const [rawEmail, ...flags] = process.argv.slice(2);
  const revoke = flags.includes('--revoke');

  if (!rawEmail) {
    console.error('Usage: operator:grant <email> [--revoke]');
    process.exit(2);
  }

  if (!config.DATABASE_URL) {
    console.error('DATABASE_URL is not set, so there is no account table to change.');
    process.exit(1);
  }

  // Stored lowercased and trimmed, and matched the same way, so the address as
  // somebody types it on a command line finds the account they mean.
  const email = rawEmail.trim().toLowerCase();

  const database = createDatabase(config, logger());
  await database.connect();

  try {
    const user = await database.client.user.findUnique({
      where: { email },
      select: { id: true, username: true, isOperator: true },
    });

    if (!user) {
      console.error(`No account here uses ${email}.`);
      process.exit(1);
    }

    if (user.isOperator === !revoke) {
      console.log(`${user.username} is already ${revoke ? 'not ' : ''}an operator. Nothing to do.`);
      return;
    }

    /*
     * Refuses to remove the last one.
     *
     * The same rule the API applies, repeated here rather than shared, because
     * this script exists precisely for when the API is not the way in — and a
     * rule that is only enforced on the path somebody is not taking is not a
     * rule.
     */
    if (revoke) {
      const operators = await database.client.user.count({ where: { isOperator: true } });
      if (operators <= 1) {
        console.error('That is the only operator. Grant somebody else access first.');
        process.exit(1);
      }
    }

    await database.client.user.update({
      where: { id: user.id },
      data: { isOperator: !revoke },
    });

    console.log(`${user.username} is ${revoke ? 'no longer' : 'now'} an operator.`);
  } finally {
    await database.disconnect();
  }
}

main().catch((error: unknown) => {
  console.error('Could not change operator access:', error);
  process.exit(1);
});
