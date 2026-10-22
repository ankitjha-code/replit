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

async function main(): Promise<void> {
  const envFile = loadDotEnv();

  const config = env();
  const log = logger();

  const deps = createDependencies();

  if (deps.database) {
    await deps.database.connect();
  } else {
    log.warn('no DATABASE_URL configured; running without a database');
  }

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
        envFile: envFile ?? '(none)',
        registerRateLimit: `${config.RATE_LIMIT_REGISTER_MAX}/${config.RATE_LIMIT_REGISTER_WINDOW_MS}ms`,
        trustProxy: config.TRUST_PROXY,
      },
      'control plane listening',
    );
  });

  server.headersTimeout = 65_000;
  server.requestTimeout = 0;

  const socketGuard = new SocketGuard({
    maxPerUser: config.MAX_SOCKETS_PER_USER,
    maxAttempts: config.MAX_SOCKET_ATTEMPTS,
    attemptWindowMs: config.SOCKET_ATTEMPT_WINDOW_MS,
    log,
  });

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

  refuseUnroutedUpgrades(server);

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

  const artifacts = deps.auth
    ? new ArtifactStore(deps.storage, { maxCacheBytes: config.DEPLOYMENT_STATIC_CACHE_BYTES }, log)
    : undefined;

  if (deps.auth && artifacts) {
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

  deps.auth?.events.onAny((projectId, event) => {
    if (event.type !== 'members.changed') return;

    terminals?.disconnectUser(projectId, event.userId);
    output?.disconnectUser(projectId, event.userId);
    projectEvents?.disconnectUser(projectId, event.userId);
    documents?.disconnectUser(projectId, event.userId);

    void deps.auth?.documents.releaseUser(projectId, event.userId);
  });

  deps.auth?.worker?.start();

  const shutdown = createShutdownHandler({
    closeConnections: async () => {
      await output?.close();
      await projectEvents?.close();
      await documents?.close();
      await deps.auth?.documents.closeAll();
      await terminals?.close();
      await deps.auth?.terminals.closeAll();
      await previews?.close();
      await deployments?.close();
      await deps.auth?.worker?.stop();
      await deps.auth?.logs.close();
      await deps.queue.close();
      await deps.auth?.eventRelay?.close();
    },
    closeServer: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
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
  console.error('Failed to start control plane:', error);
  process.exit(1);
});
