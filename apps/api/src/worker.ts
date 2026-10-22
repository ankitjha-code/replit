import { createDependencies } from './app.js';
import { loadDotEnv } from './config/dotenv.js';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { startSweepSchedule } from './modules/maintenance/sweep-schedule.js';

async function main(): Promise<void> {
  const envFile = loadDotEnv();

  const config = env();
  const log = logger().child({ process: 'worker' });

  const deps = createDependencies({ ...config, JOB_WORKER_ENABLED: true });

  if (!deps.database || !deps.auth?.worker) {
    console.error('A worker needs DATABASE_URL. Nothing to do; exiting.');
    process.exit(1);
  }

  await deps.database.connect();

  await deps.auth.recovery.recover().catch((error: unknown) => {
    log.error({ err: error }, 'startup recovery failed; the worker is starting anyway');
  });

  const worker = deps.auth.worker;
  worker.start();

  const domainChecks = setInterval(
    () => {
      void deps.auth?.domains
        .recheckVerified({
          olderThanMs: config.DOMAIN_RECHECK_AFTER_MS,
          missesBeforeLapse: config.DOMAIN_RECHECK_MISSES,
          limit: config.DOMAIN_RECHECK_BATCH,
        })
        .catch((error: unknown) => log.error({ err: error }, 'domain re-check failed'));
    },
    Math.min(config.DOMAIN_RECHECK_AFTER_MS, config.ORPHAN_SWEEP_INTERVAL_MS),
  );
  domainChecks.unref();

  const alertChecks = setInterval(() => {
    void deps.auth?.alerts.evaluate();
  }, config.ALERT_CHECK_INTERVAL_MS);
  alertChecks.unref();

  const diskChecks = setInterval(() => {
    void deps.auth?.runtimes
      .enforceDiskLimit(config.RUNTIME_DISK_MB * 1024 * 1024)
      .catch((error: unknown) => log.error({ err: error }, 'environment disk check failed'));
    void deps.auth?.deployments
      .enforceDiskLimit(config.DEPLOYMENT_DISK_MB * 1024 * 1024)
      .catch((error: unknown) => log.error({ err: error }, 'deployment disk check failed'));
  }, config.DISK_CHECK_INTERVAL_MS);
  diskChecks.unref();

  const sweeps = config.ORPHAN_SWEEP_ENABLED
    ? startSweepSchedule(deps.auth.maintenance, {
        intervalMs: config.ORPHAN_SWEEP_INTERVAL_MS,
        log,
      })
    : undefined;

  log.info(
    {
      workerId: worker.id,
      queue: deps.queue.name,
      envFile: envFile ?? '(none)',
      sweeps: config.ORPHAN_SWEEP_ENABLED
        ? `every ${Math.round(config.ORPHAN_SWEEP_INTERVAL_MS / 60_000)} minutes`
        : 'disabled',
      pollIntervalMs: config.JOB_POLL_INTERVAL_MS,
    },
    'worker listening for work',
  );

  let stopping = false;

  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;

    log.info({ signal }, 'worker shutting down');

    void (async () => {
      sweeps?.stop();
      clearInterval(domainChecks);
      clearInterval(alertChecks);
      clearInterval(diskChecks);
      await worker.stop();
      await deps.queue.close();
      await deps.auth?.logs.close();
      await deps.database?.disconnect();

      log.info('worker stopped');
      process.exit(0);
    })();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    log.error({ err: reason }, 'unhandled promise rejection');
  });
  process.on('uncaughtException', (err) => {
    log.fatal({ err }, 'uncaught exception');
    process.exit(1);
  });
}

main().catch((error: unknown) => {
  console.error('Failed to start worker:', error);
  process.exit(1);
});
