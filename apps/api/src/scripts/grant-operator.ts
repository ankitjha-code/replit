import { createDatabase } from '../db/client.js';
import { loadDotEnv } from '../config/dotenv.js';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

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
