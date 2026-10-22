import { createDependencies } from './app.js';
import { loadDotEnv } from './config/dotenv.js';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { startSweepSchedule } from './modules/maintenance/sweep-schedule.js';

/**
 * A worker, as its own process.
 *
 * The same code the control plane runs inside itself when `JOB_WORKER_ENABLED`
 * is true, started on its own instead. Nothing is duplicated: this builds the
 * same dependency graph, gets the same worker, and claims from the same table.
 * What makes two workers safe is the claim, not an agreement between them about
 * who runs which job.
 *
 * Why have it at all, when the control plane can do the work itself:
 *
 *  - **Building a project is the heaviest thing this platform does.** Running it
 *    beside the thing serving requests means a build competing with a page load
 *    for the same processor.
 *  - **Workers can be scaled and restarted separately.** A deploy of the API
 *    should not have to wait for a dependency install to finish, and a worker
 *    that needs more memory should not force the API to have it too.
 *  - **It proves the split.** A worker in the same process can quietly come to
 *    depend on something only the request path sets up. One in its own process
 *    cannot.
 *
 * No HTTP listener, no sockets, no preview server. This process accepts nothing
 * from outside and only ever reads work it was given.
 */
async function main(): Promise<void> {
  // Before any other module reads configuration.
  const envFile = loadDotEnv();

  const config = env();
  const log = logger().child({ process: 'worker' });

  /*
   * Started whatever the configuration says about the control plane's own
   * worker.
   *
   * `JOB_WORKER_ENABLED` answers "should the API also do the work", and this
   * process exists precisely to do the work: honouring that flag here would give
   * an operator a way to start a worker that refuses to work.
   */
  const deps = createDependencies({ ...config, JOB_WORKER_ENABLED: true });

  if (!deps.database || !deps.auth?.worker) {
    /*
     * Nothing to claim from.
     *
     * A worker with no database has no job table, which is the whole of its
     * input. Refusing to start beats a process that sits there looking healthy
     * and picking up nothing.
     */
    console.error('A worker needs DATABASE_URL. Nothing to do; exiting.');
    process.exit(1);
  }

  await deps.database.connect();

  /*
   * The worker recovers too, and that is not a duplicate.
   *
   * Either process may be the one that comes back first, and whichever it is
   * should be the one that makes the records true. Both doing it is harmless:
   * every write recovery makes names the status and revision it believes, so the
   * second instance changes nothing rather than changing it twice.
   */
  await deps.auth.recovery.recover().catch((error: unknown) => {
    log.error({ err: error }, 'startup recovery failed; the worker is starting anyway');
  });

  const worker = deps.auth.worker;
  worker.start();

  /*
   * Cleanup lives here, and only here.
   *
   * Not in the API: a sweep talks to every machine the platform uses and
   * deletes things, which has no business sharing a process with page loads, and
   * several API instances doing it at once would enumerate and delete the same
   * containers. One worker is the natural home. Two workers race harmlessly —
   * removing something already gone succeeds everywhere in this codebase.
   */
  /*
   * Custom domains that have stopped pointing here.
   *
   * On the sweep's clock rather than a clock of its own: both are slow,
   * periodic checks of the world outside the database, and one interval to
   * reason about is better than two. Each pass looks at a bounded batch, so a
   * resolver is never asked about every domain at once.
   */
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

  /*
   * Deployment alerts, for projects that turned them on.
   *
   * Here and not in the API for the same reasons as the sweep: it measures
   * things on a timer, and several API instances would each send the email.
   * Two workers are safe because each pass claims its projects.
   */
  const alertChecks = setInterval(() => {
    void deps.auth?.alerts.evaluate();
  }, config.ALERT_CHECK_INTERVAL_MS);
  alertChecks.unref();

  /*
   * Disk limits, measured. Environments and server deployments that have
   * written more than they may are stopped, and their owners told why.
   */
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
      /*
       * The job in hand is finished first.
       *
       * Stopping mid-job would leave a row RUNNING with nobody holding it, which
       * is the state a restart cannot tell apart from a crash. Finishing costs a
       * moment and avoids inventing that state on every ordinary restart.
       */
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
  // The logger may itself depend on configuration that failed to load.
  console.error('Failed to start worker:', error);
  process.exit(1);
});
