import { createApp, createDependencies } from './app.js';
import { loadDotEnv } from './config/dotenv.js';
import { env } from './config/env.js';
import { createShutdownHandler } from './lifecycle/shutdown.js';
import { logger } from './lib/logger.js';
import { ArtifactStore } from './deploy/artifact-store.js';
import { createDeploymentServer } from './deploy/deployment-server.js';
import { createPreviewServer } from './preview/preview-server.js';
import { SocketGuard } from './ws/socket-guard.js';
import { createDocumentGateway } from './ws/document-gateway.js';
import { refuseUnroutedUpgrades } from './ws/unrouted-upgrade.js';
import { createProjectEventsGateway } from './ws/events-gateway.js';
import { createOutputGateway } from './ws/output-gateway.js';
import { createTerminalGateway } from './ws/terminal-gateway.js';

/**
 * Process entrypoint.
 *
 * Startup fails fast: a control plane that cannot reach its database must not
 * accept traffic and report itself healthy for a while first. Shutdown is
 * ordered, and its sequencing lives in a tested unit rather than here.
 */
async function main(): Promise<void> {
  // Before any other module reads configuration.
  const envFile = loadDotEnv();

  const config = env();
  const log = logger();

  const deps = createDependencies();

  if (deps.database) {
    await deps.database.connect();
  } else {
    log.warn('no DATABASE_URL configured; running without a database');
  }

  /*
   * What the last process was in the middle of, resolved before this one
   * accepts anything.
   *
   * Before `listen`, on purpose. A request arriving against a runtime whose row
   * still says `STARTING` from a process that died would be told to wait for
   * something nobody is doing. The pass is one query per table and a handful of
   * inspections, so paying for it before the port opens costs a moment at boot
   * and removes a whole class of state nothing else can clear.
   *
   * Never fatal. A platform that refuses to start because it could not
   * reconcile is worse than one that starts with stale rows: the rows are
   * visible and correct themselves on the next boot, and a process that will
   * not start is neither.
   */
  if (deps.auth) {
    await deps.auth.recovery.recover().catch((error: unknown) => {
      log.error({ err: error }, 'startup recovery failed; starting anyway');
    });
  }

  const app = createApp(deps);

  const server = app.listen(config.API_PORT, config.API_HOST, () => {
    log.info(
      {
        host: config.API_HOST,
        port: config.API_PORT,
        env: config.NODE_ENV,
        // The path only; the file's contents are secret.
        envFile: envFile ?? '(none)',
        // Effective abuse limits, so an operator can confirm what is actually
        // in force rather than what a config file appears to say.
        registerRateLimit: `${config.RATE_LIMIT_REGISTER_MAX}/${config.RATE_LIMIT_REGISTER_WINDOW_MS}ms`,
        trustProxy: config.TRUST_PROXY,
      },
      'control plane listening',
    );
  });

  // Long connections (WebSockets, log streams) must not hold shutdown open.
  server.headersTimeout = 65_000;
  server.requestTimeout = 0;

  /*
   * Limits that span every gateway.
   *
   * One object shared by all four, because the two things it counts only mean
   * anything across them: how many sockets an account holds in total, and how
   * fast one client is attempting to connect. A per-gateway copy would let
   * somebody hold four times the budget by using four kinds of socket.
   */
  const socketGuard = new SocketGuard({
    maxPerUser: config.MAX_SOCKETS_PER_USER,
    maxAttempts: config.MAX_SOCKET_ATTEMPTS,
    attemptWindowMs: config.SOCKET_ATTEMPT_WINDOW_MS,
    log,
  });

  /*
   * The application's output, when there is a database to authorize against.
   *
   * Registered before the terminal gateway. Both are attached to the same
   * upgrade event, and each leaves alone the route the other serves.
   */
  const output = deps.auth
    ? createOutputGateway(server, {
        runs: deps.auth.runs,
        sessions: deps.auth.sessions,
        authorization: deps.auth.authorization,
        cookie: deps.cookie,
        allowedOrigins: config.CORS_ORIGINS,
        guard: socketGuard,
        maxPerProject: config.MAX_OUTPUT_WATCHERS_PER_PROJECT,
        heartbeatMs: config.TERMINAL_HEARTBEAT_MS,
        log,
      })
    : undefined;

  /*
   * What is happening in the project, and who else is in it.
   *
   * Registered between the other two and, like them, it looks only at its own
   * route and leaves every other upgrade alone. Absent without a database for
   * the same reason the others are: there is no project to be present in.
   */
  const projectEvents = deps.auth
    ? createProjectEventsGateway(server, {
        events: deps.auth.events,
        sessions: deps.auth.sessions,
        authorization: deps.auth.authorization,
        cookie: deps.cookie,
        allowedOrigins: config.CORS_ORIGINS,
        guard: socketGuard,
        maxPerProject: config.MAX_EVENT_WATCHERS_PER_PROJECT,
        heartbeatMs: config.TERMINAL_HEARTBEAT_MS,
        log,
      })
    : undefined;

  /*
   * Shared documents, when there are files to share.
   *
   * Its own route, checked before any upgrade is touched, exactly as the other
   * gateways do with theirs.
   */
  const documents = deps.auth
    ? createDocumentGateway(server, {
        documents: deps.auth.documents,
        sessions: deps.auth.sessions,
        authorization: deps.auth.authorization,
        cookie: deps.cookie,
        allowedOrigins: config.CORS_ORIGINS,
        guard: socketGuard,
        maxPerProject: config.MAX_DOCUMENT_EDITORS_PER_PROJECT,
        heartbeatMs: config.TERMINAL_HEARTBEAT_MS,
        messageBurst: config.SOCKET_MESSAGE_BURST,
        messagesPerSecond: config.SOCKET_MESSAGES_PER_SECOND,
        log,
      })
    : undefined;

  /*
   * Terminals, when there is anything to attach them to.
   *
   * Absent without a database, because a terminal has to be authorized against
   * a project and there is nothing to authorize against. A gateway that
   * accepted sockets and then refused every one would be worse than no route
   * at all.
   *
   * The sweep for shells nobody came back to starts with the process rather
   * than with the service, so building the object in a test schedules nothing.
   * A minute is far finer than the idle limit it enforces, which is what keeps
   * the check cheap and its timing unsurprising.
   */
  deps.auth?.terminals.startReaping(60_000);

  const terminals = deps.auth
    ? createTerminalGateway(server, {
        terminals: deps.auth.terminals,
        sessions: deps.auth.sessions,
        authorization: deps.auth.authorization,
        cookie: deps.cookie,
        allowedOrigins: config.CORS_ORIGINS,
        guard: socketGuard,
        maxPerProject: config.MAX_TERMINALS_PER_PROJECT,
        heartbeatMs: config.TERMINAL_HEARTBEAT_MS,
        messageBurst: config.SOCKET_MESSAGE_BURST,
        messagesPerSecond: config.SOCKET_MESSAGES_PER_SECOND,
        log,
      })
    : undefined;

  deps.metrics?.useSocketCount(() => socketGuard.total());

  // Anything no gateway above serves is refused here, once.
  refuseUnroutedUpgrades(server);

  /*
   * The preview listener, on its own port and its own hostnames.
   *
   * A second server rather than a route on the first, because what it serves
   * is a project's own pages. On the platform's origin those pages could act
   * as the person looking at them.
   */
  const previews = deps.auth
    ? createPreviewServer({
        previews: deps.auth.previews,
        hostSuffix: config.PREVIEW_HOST_SUFFIX,
        cookieName: config.PREVIEW_COOKIE_NAME,
        cookieSecure: config.PREVIEW_SCHEME === 'https',
        sessionTtlSeconds: config.PREVIEW_SESSION_TTL_SECONDS,
        workspaceUrl: config.CORS_ORIGINS[0] ?? config.API_PUBLIC_URL,
        log,
      })
    : undefined;

  /*
   * Deployed projects, on their own port and their own hostnames.
   *
   * A third listener for the same reason there is a second: what it serves is
   * somebody else's code, and on the platform's origin it could act as whoever
   * opened it. This one is public — no account, no cookie, no session — which
   * is the whole point of a deployment and the reason it shares nothing with
   * the control plane but a database connection.
   */
  const artifacts = deps.auth
    ? new ArtifactStore(deps.storage, { maxCacheBytes: config.DEPLOYMENT_STATIC_CACHE_BYTES }, log)
    : undefined;

  if (deps.auth && artifacts) {
    // So a removed deployment stops being served from memory as well as from
    // storage.
    deps.auth.deployments.useArtifacts(artifacts);
  }

  const deployments =
    deps.auth && artifacts
      ? createDeploymentServer({
          deployments: deps.auth.deployments,
          artifacts,
          domains: deps.auth.domains,
          log,
        })
      : undefined;

  if (deployments) {
    await deployments.listen(config.DEPLOYMENT_PORT, config.API_HOST);
    log.info(
      { port: config.DEPLOYMENT_PORT, hostSuffix: config.DEPLOYMENT_HOST_SUFFIX },
      'deployment listener ready',
    );
  }

  if (previews) {
    await previews.listen(config.PREVIEW_PORT, config.API_HOST);
    log.info(
      { port: config.PREVIEW_PORT, hostSuffix: config.PREVIEW_HOST_SUFFIX },
      'preview listener ready',
    );
  }

  /*
   * Losing access to a project closes the sockets it granted.
   *
   * Every socket here is authorized once, at upgrade, and then held open for as
   * long as somebody keeps a tab open. Without this, removing somebody from a
   * project leaves them with a live shell inside its container, a live view of
   * everything happening in it, and an editor whose keystrokes are still being
   * written to its files.
   *
   * They are closed rather than quietly downgraded, because the client then
   * reconnects and is authorized again from scratch: somebody who still belongs
   * is back within a second, and somebody who does not is refused at the door.
   */
  deps.auth?.events.onAny((projectId, event) => {
    if (event.type !== 'members.changed') return;

    terminals?.disconnectUser(projectId, event.userId);
    output?.disconnectUser(projectId, event.userId);
    projectEvents?.disconnectUser(projectId, event.userId);
    documents?.disconnectUser(projectId, event.userId);

    // The socket is gone; the document it was attached to is released here, so
    // a file nobody is left holding is written back rather than kept open by a
    // membership that no longer exists.
    void deps.auth?.documents.releaseUser(projectId, event.userId);
  });

  /*
   * The worker, when this process is also doing the work.
   *
   * Started after everything it needs exists and before the server accepts
   * traffic, so a job queued by the first request is picked up rather than
   * waiting for a poll. A control plane started with `JOB_WORKER_ENABLED=false`
   * has none, and something else is expected to be running one.
   */
  deps.auth?.worker?.start();

  const shutdown = createShutdownHandler({
    // Before the HTTP server, so open terminals are told the platform is going
    // away rather than having the socket cut from under them.
    closeConnections: async () => {
      await output?.close();
      await projectEvents?.close();
      await documents?.close();
      /*
       * The documents themselves, after the sockets showing them.
       *
       * A shared document is the only state in this platform that lives purely
       * in memory, so this is the one shutdown step whose omission would lose
       * work rather than merely interrupt it.
       */
      await deps.auth?.documents.closeAll();
      await terminals?.close();
      // The shells themselves, after the sockets showing them. A session
      // outlives its socket by design, so closing the gateway would otherwise
      // leave every shell running in a container the platform has stopped
      // watching.
      await deps.auth?.terminals.closeAll();
      await previews?.close();
      await deployments?.close();
      /*
       * Whatever a program printed in the last second, written down.
       *
       * After the listeners close, because output arriving during shutdown is
       * still output somebody may want. The one piece of state here that is
       * held in memory on purpose, and therefore the one that has to be flushed.
       */
      /*
       * The worker before the log, and both before the database.
       *
       * Stopping the worker waits for the job in hand: abandoning one would
       * leave a row RUNNING with nobody holding it, which a restart cannot tell
       * apart from a crash. Whatever that job printed is then flushed.
       */
      await deps.auth?.worker?.stop();
      await deps.auth?.logs.close();
      await deps.queue.close();
      await deps.auth?.eventRelay?.close();
    },
    closeServer: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
        // Keep-alive sockets sitting idle would otherwise hold the close open
        // for as long as a client cares to wait.
        server.closeIdleConnections();
      }),
    disconnectDatabase: deps.database ? () => deps.database!.disconnect() : undefined,
    log,
    exit: (code) => process.exit(code),
  });

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
  console.error('Failed to start control plane:', error);
  process.exit(1);
});
