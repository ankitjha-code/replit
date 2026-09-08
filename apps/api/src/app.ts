import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import { env, type Env } from './config/env.js';
import { createDatabase, type DatabaseHandle } from './db/client.js';
import { databaseProbe } from './db/db-probe.js';
import { ProjectEventBus } from './events/project-event-bus.js';
import { RedisEventRelay } from './events/redis-event-relay.js';
import { createJobQueue } from './jobs/create-queue.js';
import { createJobWorker, type JobHandler, type JobWorker } from './jobs/job-worker.js';
import type { JobQueue } from './jobs/queue.js';
import { queueProbe } from './jobs/queue-probe.js';
import { createDeploymentProvider } from './deploy/create-provider.js';
import { deploymentProbe } from './deploy/deployment-probe.js';
import type { JobType } from '@platform/shared';
import type { DeploymentProvider } from './deploy/provider.js';
import { createExecutionProvider } from './execution/create-provider.js';
import { createMailProvider } from './mail/create-mail.js';
import type { MailProvider } from './mail/provider.js';
import { createStorageProvider } from './storage/create-storage.js';
import type { StorageProvider } from './storage/provider.js';
import { executionHostProbe, executionProbe } from './execution/execution-probe.js';
import { resolveHosts } from './execution/create-provider.js';
import { DatabasePlacementSource } from './execution/placement-source.js';
import type { PlacementSource } from './execution/scheduler.js';
import type { ExecutionProvider } from './execution/provider.js';
import { logger } from './lib/logger.js';
import { createPasswordHasher, type PasswordHasher } from './lib/password.js';
import { attachSession, requireAuth } from './http/middleware/authenticate.js';
import { errorHandler, notFoundHandler } from './http/middleware/error-handler.js';
import { checkOrigin } from './http/middleware/origin-check.js';
import {
  MemoryRateLimitStore,
  rateLimit,
  type RateLimitStore,
} from './http/middleware/rate-limit.js';
import { requestContext } from './http/middleware/request-context.js';
import { requestTimeout } from './http/middleware/request-timeout.js';
import { securityHeaders } from './http/middleware/security-headers.js';
import { sessionCookieSettings, type SessionCookieSettings } from './http/session-cookie.js';
import { authRoutes } from './modules/auth/auth.routes.js';
import { AuthenticationService } from './modules/auth/authentication.service.js';
import { RegistrationService } from './modules/auth/registration.service.js';
import { SessionService } from './modules/auth/session.service.js';
import { RecoveryRepository } from './lifecycle/recovery.repository.js';
import { StartupRecovery } from './lifecycle/recovery.js';
import { MaintenanceRepository } from './modules/maintenance/maintenance.repository.js';
import { OrphanSweeper } from './modules/maintenance/orphan-sweeper.js';
import { AccountTokenRepository } from './modules/verification/token.repository.js';
import { VerificationService } from './modules/verification/verification.service.js';
import { operationsRoutes } from './modules/operations/operations.routes.js';
import { OperationsRepository } from './modules/operations/operations.repository.js';
import { OperationsService } from './modules/operations/operations.service.js';
import { accountRoutes } from './modules/account/account.routes.js';
import { AccountService } from './modules/account/account.service.js';
import { TwoFactorRepository } from './modules/two-factor/two-factor.repository.js';
import { TwoFactorService } from './modules/two-factor/two-factor.service.js';
import { healthRoutes } from './modules/health/health.routes.js';
import { HealthService } from './modules/health/health.service.js';
import { registerInfrastructureProbes } from './modules/health/register-dependencies.js';
import { DocumentSessionService } from './modules/documents/document-session.service.js';
import { fileRoutes } from './modules/files/file.routes.js';
import { FileRepository } from './modules/files/file.repository.js';
import { DEFAULT_FILE_OPTIONS, FileService } from './modules/files/file.service.js';
import { AuthorizationService } from './modules/projects/authorization.service.js';
import { MembershipService } from './modules/projects/membership.service.js';
import { projectRoutes } from './modules/projects/project.routes.js';
import { ProjectRepository } from './modules/projects/project.repository.js';
import { ProjectService } from './modules/projects/project.service.js';
import { previewRoutes } from './modules/preview/preview.routes.js';
import { PreviewGrantRepository } from './modules/preview/preview.repository.js';
import { PreviewService } from './modules/preview/preview.service.js';
import { assetRoutes } from './modules/assets/asset.routes.js';
import { secretRoutes } from './modules/secrets/secret.routes.js';
import { variableRoutes } from './modules/variables/variable.routes.js';
import { databaseRoutes } from './modules/databases/database.routes.js';
import { DatabaseRepository } from './modules/databases/database.repository.js';
import { DatabaseService } from './modules/databases/database.service.js';
import { BackupRepository } from './modules/databases/backup.repository.js';
import { BackupService } from './modules/databases/backup.service.js';
import { domainRoutes, certificateAuthorizationRoutes } from './modules/domains/domain.routes.js';
import { DomainRepository } from './modules/domains/domain.repository.js';
import { DomainService } from './modules/domains/domain.service.js';
import { jobRoutes } from './modules/jobs/job.routes.js';
import { quotaRoutes } from './modules/quotas/quota.routes.js';
import { QuotaRepository } from './modules/quotas/quota.repository.js';
import { QuotaService } from './modules/quotas/quota.service.js';
import { JobRepository } from './modules/jobs/job.repository.js';
import { JobService } from './modules/jobs/job.service.js';
import { logRoutes } from './modules/logs/log.routes.js';
import { monitoringRoutes } from './modules/monitoring/monitoring.routes.js';
import { HealthCheckSettings } from './modules/monitoring/monitoring.repository.js';
import { MonitoringService } from './modules/monitoring/monitoring.service.js';
import { MetricsRepository } from './modules/metrics/metrics.repository.js';
import { MetricsService } from './modules/metrics/metrics.service.js';
import { AlertRepository } from './modules/alerts/alert.repository.js';
import { alertRoutes } from './modules/alerts/alert.routes.js';
import { AlertService } from './modules/alerts/alert.service.js';
import { LogRepository } from './modules/logs/log.repository.js';
import { LogService } from './modules/logs/log.service.js';
import { deploymentRoutes } from './modules/deployments/deployment.routes.js';
import { DeploymentRepository } from './modules/deployments/deployment.repository.js';
import { DeploymentService } from './modules/deployments/deployment.service.js';
import { gitRoutes } from './modules/git/git.routes.js';
import { GitRemoteStore, GitRepositoryStore } from './modules/git/git.repository.js';
import { GitService } from './modules/git/git.service.js';
import { RestoreService } from './modules/restore/restore.service.js';
import { snapshotRoutes } from './modules/snapshots/snapshot.routes.js';
import { SnapshotRepository } from './modules/snapshots/snapshot.repository.js';
import { SnapshotService } from './modules/snapshots/snapshot.service.js';
import { createUserDatabaseProvider } from './userdb/create-provider.js';
import { userDatabaseProbe } from './userdb/userdb-probe.js';
import type { UserDatabaseProvider } from './userdb/provider.js';
import { VariableRepository } from './modules/variables/variable.repository.js';
import { VariableService } from './modules/variables/variable.service.js';
import { SecretRepository } from './modules/secrets/secret.repository.js';
import { SecretService } from './modules/secrets/secret.service.js';
import { createKeyRing, parseEncryptionKey, parsePreviousKeys } from './lib/secret-box.js';
import { AssetRepository } from './modules/assets/asset.repository.js';
import { AssetService } from './modules/assets/asset.service.js';
import { runtimeRoutes } from './modules/runtimes/runtime.routes.js';
import { RuntimeRepository } from './modules/runtimes/runtime.repository.js';
import { RunService } from './modules/runtimes/run.service.js';
import { TerminalRepository } from './modules/runtimes/terminal.repository.js';
import { RuntimeService } from './modules/runtimes/runtime.service.js';
import { TerminalSessionService } from './modules/runtimes/terminal-session.service.js';
import { SessionRepository } from './modules/sessions/session.repository.js';
import { UserRepository } from './modules/users/user.repository.js';
import { APP_VERSION } from './version.js';

/**
 * Everything that needs a database is grouped, because they are all present or
 * all absent together. Without this the type would permit a registration
 * service with no session service, which cannot happen and would have to be
 * guarded against everywhere.
 */
export interface AuthDependencies {
  registration: RegistrationService;
  authentication: AuthenticationService;
  sessions: SessionService;
  projects: ProjectRepository;
  projectService: ProjectService;
  files: FileService;
  /** Files open for collaborative editing. In memory, and only while open. */
  documents: DocumentSessionService;
  members: MembershipService;
  runtimes: RuntimeService;
  runs: RunService;
  terminals: TerminalSessionService;
  assets: AssetService;
  secrets: SecretService;
  variables: VariableService;
  databases: DatabaseService;
  /** Copies of a project's database, taken and put back by running pg_dump. */
  databaseBackups: BackupService;
  deployments: DeploymentService;
  domains: DomainService;
  logs: LogService;
  monitoring: MonitoringService;
  alerts: AlertService;
  jobs: JobService;
  quotas: QuotaService;
  /**
   * The worker this process runs, when it runs one.
   *
   * Absent when the control plane was started to accept work and not do it,
   * which is the arrangement where workers are their own processes. The jobs
   * page is told either way, because queued work nobody is picking up is a
   * promise the platform cannot keep.
   */
  worker?: JobWorker;
  /**
   * Cleanup of what the platform made and then lost track of.
   *
   * Built wherever there is a database, and *started* only by the worker
   * process. Several API instances sweeping at once would enumerate and delete
   * the same things, and the sweep has no business competing with a page load.
   */
  maintenance: OrphanSweeper;
  /**
   * Makes the platform's records true again after it stops unexpectedly.
   *
   * Run once at boot by whichever process is starting, before it serves
   * anything. Safe to run in two at once: every write it makes is the same
   * optimistic transition every other caller uses.
   */
  recovery: StartupRecovery;
  /** What the holder of an account may do to it: password, sessions, closure. */
  account: AccountService;
  /** Proving an address, and getting back in without a password. */
  verification: VerificationService;
  /** The installation as a whole, for the people who run it. */
  operations: OperationsService;
  /** A second factor at sign-in. */
  twoFactor: TwoFactorService;
  /** Carries events to other instances, when Redis is configured. */
  eventRelay?: RedisEventRelay;
  snapshots: SnapshotService;
  git: GitService;
  restore: RestoreService;
  previews: PreviewService;
  authorization: AuthorizationService;
  /**
   * Where every change in a project is announced.
   *
   * On the authenticated group rather than beside it: an event is about a
   * project, and without a database there are no projects for anything to
   * happen in.
   */
  events: ProjectEventBus;
}

export interface AppDependencies {
  config: Env;
  health: HealthService;
  /** The platform's own numbers, served at `/metrics` when a token is set. */
  metrics?: MetricsService;
  /** Always present. With no backend configured it refuses, saying why. */
  execution: ExecutionProvider;
  /** Always present. With nowhere to put bytes it refuses, saying why. */
  storage: StorageProvider;
  /**
   * Always present. With no mail server it refuses, saying why.
   *
   * Which is what lets address verification and password reset be *offered* as
   * unavailable on an installation without mail, rather than failing when
   * somebody tries them.
   */
  mail: MailProvider;
  /** Always present. With no server for project databases it refuses, saying why. */
  userDatabases: UserDatabaseProvider;
  /** Always present. With nowhere to deploy it refuses, saying why. */
  deployment: DeploymentProvider;
  /**
   * Always present. Without Redis it is an in-process notifier, which genuinely
   * works and does not cross a process boundary.
   */
  queue: JobQueue;
  rateLimitStore: RateLimitStore;
  cookie: SessionCookieSettings;
  passwordHasher: PasswordHasher;
  /** Absent when no database is configured, which is the case in unit tests. */
  database?: DatabaseHandle;
  auth?: AuthDependencies;
}

/**
 * Builds the dependency graph. The composition root for the control plane.
 *
 * Every long-lived resource is created here and passed down, rather than
 * reached for through a module-level singleton. That is what makes it possible
 * to stand the application up twice in one test process with different
 * configuration, or with a cheap password hasher in place of the real one.
 */
export function createDependencies(
  config = env(),
  overrides: { passwordHasher?: PasswordHasher } = {},
): AppDependencies {
  const log = logger();
  const health = new HealthService('api', APP_VERSION);
  const passwordHasher = overrides.passwordHasher ?? createPasswordHasher();
  const cookie = sessionCookieSettings(config);

  const database = config.DATABASE_URL ? createDatabase(config, log) : undefined;

  /*
   * What the platform has already placed, for the scheduler.
   *
   * Absent without a database, which is the case in unit tests and in a control
   * plane that cannot run anything anyway. The provider factory falls back to a
   * single host and says so, rather than scheduling against nothing.
   */
  const deploymentLimits = {
    cpuMillicores: config.DEPLOYMENT_CPU_MILLICORES,
    memoryMb: config.DEPLOYMENT_MEMORY_MB,
  };

  const placement = database
    ? new DatabasePlacementSource(database.client, deploymentLimits)
    : undefined;

  const execution = createExecutionProvider(config, log, placement);
  const storage = createStorageProvider(config, log);
  const mail = createMailProvider(config, log);
  const userDatabases = createUserDatabaseProvider(config, log);
  const deployment = createDeploymentProvider(config, execution, log);
  const queue = createJobQueue(config, log);

  registerInfrastructureProbes(health, config, database !== undefined);
  if (config.EXECUTION_PROVIDER !== 'none') {
    /*
     * One row per host once there is more than one.
     *
     * "The execution plane is up" is not a useful answer for an installation
     * with three machines and one down: the whole point of having three is that
     * losing one is survivable, and an operator needs to know which. A
     * single-host installation keeps the single row it had.
     */
    const hosts = resolveHosts(config);

    if (hosts.length > 1 && placement) {
      for (const host of hosts) {
        health.register(executionHostProbe(host, execution, placement));
      }
    } else {
      health.register(executionProbe(execution));
    }
  }
  // Only when one is configured. An installation that deliberately does not
  // deploy is not unhealthy for it.
  if (config.DEPLOYMENT_PROVIDER !== 'none') {
    health.register(deploymentProbe(deployment));
  }
  // Only when a real one is configured. The in-process queue has nothing to be
  // unreachable, and a permanently green row saying so would be noise.
  if (config.REDIS_URL) {
    health.register(queueProbe(queue));
  }
  // Only when one is configured. An installation that deliberately gives
  // projects no database is not unhealthy for it.
  if (config.USER_DATABASE_ADMIN_URL) {
    health.register(userDatabaseProbe(userDatabases));
  }
  if (database) {
    health.register(databaseProbe(database.client));
  }

  const auth = database
    ? buildAuth(
        database,
        config,
        passwordHasher,
        execution,
        storage,
        userDatabases,
        deployment,
        queue,
        mail,
        // Defined whenever the database is: they are built from the same
        // condition a few lines above.
        placement ?? new DatabasePlacementSource(database.client, deploymentLimits),
        log,
      )
    : undefined;

  return {
    config,
    health,
    metrics: new MetricsService(database ? new MetricsRepository(database.client) : undefined),
    execution,
    storage,
    mail,
    userDatabases,
    deployment,
    queue,
    rateLimitStore: new MemoryRateLimitStore(),
    cookie,
    passwordHasher,
    ...(database ? { database } : {}),
    ...(auth ? { auth } : {}),
  };
}

function buildAuth(
  database: DatabaseHandle,
  config: Env,
  passwordHasher: PasswordHasher,
  execution: ExecutionProvider,
  storage: StorageProvider,
  userDatabases: UserDatabaseProvider,
  deployment: DeploymentProvider,
  queue: JobQueue,
  mail: MailProvider,
  placement: PlacementSource,
  log: ReturnType<typeof logger>,
): AuthDependencies {
  const users = new UserRepository(database.client);
  const projects = new ProjectRepository(database.client);
  const files = new FileService(
    new FileRepository(database.client),
    {
      ...DEFAULT_FILE_OPTIONS,
      maxFileBytes: config.FILE_MAX_BYTES,
      maxProjectBytes: config.PROJECT_MAX_BYTES,
      maxEntries: config.PROJECT_MAX_FILES,
    },
    log,
  );
  const encryptionKey = parseEncryptionKey(config.SECRETS_ENCRYPTION_KEY);
  // A ring rather than a single key, so a rotation can be in progress: new
  // values sealed with the current key, old ones still readable.
  const box = encryptionKey
    ? createKeyRing(encryptionKey, parsePreviousKeys(config.SECRETS_PREVIOUS_KEYS))
    : undefined;
  const variableRepository = new VariableRepository(database.client);
  const secretRepository = new SecretRepository(database.client);
  const databaseRepository = new DatabaseRepository(database.client);

  const secrets = new SecretService(
    secretRepository,
    box,
    variableRepository,
    databaseRepository,
    { maxPerProject: config.MAX_SECRETS_PER_PROJECT },
    log,
  );
  const variables = new VariableService(
    variableRepository,
    secretRepository,
    databaseRepository,
    { maxPerProject: config.MAX_VARIABLES_PER_PROJECT },
    log,
  );
  const databases = new DatabaseService(
    databaseRepository,
    userDatabases,
    box,
    variableRepository,
    secretRepository,
    {
      containerHost: config.USER_DATABASE_CONTAINER_HOST,
      containerPort: config.USER_DATABASE_CONTAINER_PORT,
    },
    log,
  );
  const databaseBackups = new BackupService(
    new BackupRepository(database.client),
    execution,
    storage,
    {
      image: config.DATABASE_BACKUP_IMAGE,
      timeoutMs: config.DATABASE_BACKUP_TIMEOUT_MS,
      maxPerProject: config.MAX_DATABASE_BACKUPS_PER_PROJECT,
      listLimit: config.DATABASE_BACKUP_LIST_LIMIT,
      limits: {
        cpuMillicores: config.DEPLOYMENT_CPU_MILLICORES,
        memoryMb: config.DEPLOYMENT_MEMORY_MB,
        pidsLimit: config.DEPLOYMENT_PIDS_LIMIT,
      },
    },
    log,
  );

  const runtimes = new RuntimeService(
    new RuntimeRepository(database.client),
    files,
    secrets,
    variables,
    databases,
    execution,
    {
      limits: {
        cpuMillicores: config.RUNTIME_CPU_MILLICORES,
        memoryMb: config.RUNTIME_MEMORY_MB,
        pidsLimit: config.RUNTIME_PIDS_LIMIT,
      },
      stopGraceSeconds: config.RUNTIME_STOP_GRACE_SECONDS,
    },
    log,
  );
  const previews = new PreviewService(
    new RuntimeRepository(database.client),
    new PreviewGrantRepository(database.client),
    execution,
    {
      hostSuffix: config.PREVIEW_HOST_SUFFIX,
      scheme: config.PREVIEW_SCHEME,
      grantTtlSeconds: config.PREVIEW_GRANT_TTL_SECONDS,
      sessionTtlSeconds: config.PREVIEW_SESSION_TTL_SECONDS,
      probeTimeoutMs: config.PREVIEW_PROBE_TIMEOUT_MS,
    },
    log,
  );
  const assets = new AssetService(
    new AssetRepository(database.client),
    storage,
    {
      maxAssetBytes: config.ASSET_MAX_BYTES,
      maxProjectBytes: config.PROJECT_ASSET_MAX_BYTES,
    },
    log,
  );
  const runs = new RunService(
    new RuntimeRepository(database.client),
    projects,
    files,
    execution,
    {
      stopGraceSeconds: config.RUNTIME_STOP_GRACE_SECONDS,
      bufferBytes: config.RUN_OUTPUT_BUFFER_BYTES,
      bufferLines: config.RUN_OUTPUT_BUFFER_LINES,
    },
    log,
  );
  runtimes.useRunService(runs);

  const terminals = new TerminalSessionService(
    runtimes,
    new TerminalRepository(database.client),
    {
      maxPerProject: config.MAX_TERMINALS_PER_PROJECT,
      scrollbackBytes: config.TERMINAL_SCROLLBACK_BYTES,
      idleMs: config.TERMINAL_SESSION_IDLE_MS,
    },
    log,
  );
  runtimes.useTerminalSessions(terminals);

  const snapshots = new SnapshotService(
    new SnapshotRepository(database.client),
    files,
    storage,
    {
      maxPerProject: config.MAX_SNAPSHOTS_PER_PROJECT,
      maxAutomaticPerProject: config.MAX_AUTOMATIC_SNAPSHOTS_PER_PROJECT,
      maxArchiveBytes: config.SNAPSHOT_MAX_BYTES,
    },
    log,
  );

  const gitService = new GitService(
    new GitRepositoryStore(database.client),
    files,
    storage,
    {
      historyLimit: config.GIT_HISTORY_LIMIT,
      maxRepositoryBytes: config.GIT_MAX_REPOSITORY_BYTES,
    },
    log,
  );

  gitService.useRemotes(new GitRemoteStore(database.client), box, {
    allowInsecure: config.GIT_REMOTE_ALLOW_HTTP,
    allowPrivateAddresses: config.GIT_REMOTE_ALLOW_PRIVATE,
    maxResponseBytes: config.GIT_MAX_REPOSITORY_BYTES,
    timeoutMs: config.GIT_REMOTE_TIMEOUT_MS,
  });

  const restore = new RestoreService(files, snapshots, gitService, runtimes, log);

  const documents = new DocumentSessionService(
    files,
    {
      maxPerProject: config.MAX_OPEN_DOCUMENTS_PER_PROJECT,
      saveDebounceMs: config.DOCUMENT_SAVE_DEBOUNCE_MS,
      saveCeilingMs: config.DOCUMENT_SAVE_CEILING_MS,
    },
    log,
  );

  const members = new MembershipService(projects, users, log);

  const logs = new LogService(
    new LogRepository(database.client),
    {
      retainedLines: config.PROJECT_LOG_RETAINED_LINES,
      flushIntervalMs: config.PROJECT_LOG_FLUSH_MS,
      flushLines: config.PROJECT_LOG_FLUSH_LINES,
    },
    log,
  );
  runs.useLogs(logs);

  const domains = new DomainService(
    new DomainRepository(database.client),
    {
      hostSuffix: config.DEPLOYMENT_HOST_SUFFIX,
      scheme: config.DEPLOYMENT_SCHEME,
      maxPerProject: config.MAX_DOMAINS_PER_PROJECT,
      dnsTimeoutMs: config.DOMAIN_DNS_TIMEOUT_MS,
      dnsServers: config.DOMAIN_DNS_SERVERS,
      /*
       * An installation on localhost cannot usefully serve a custom domain.
       *
       * There is nothing for one to be pointed at, so every verification would
       * fail and the form would be a trap. Said once, here, rather than
       * discovered by each person who tries.
       */
      customDomainsUnavailableReason: config.DEPLOYMENT_HOST_SUFFIX.startsWith('localhost')
        ? 'This installation is only reachable as localhost, so a custom domain cannot be pointed at it.'
        : null,
    },
    log,
  );

  const deployments = new DeploymentService(
    new DeploymentRepository(database.client),
    files,
    snapshots,
    storage,
    deployment,
    runtimes,
    domains,
    variables,
    secrets,
    databases,
    {
      maxPerProject: config.MAX_DEPLOYMENTS_PER_PROJECT,
      limits: {
        cpuMillicores: config.DEPLOYMENT_CPU_MILLICORES,
        memoryMb: config.DEPLOYMENT_MEMORY_MB,
        pidsLimit: config.DEPLOYMENT_PIDS_LIMIT,
      },
      maxLogBytes: config.DEPLOYMENT_MAX_LOG_BYTES,
    },
    log,
  );
  deployments.useLogs(logs);
  /*
   * So the proxy will obtain a certificate for a release's own address.
   *
   * Set after construction because the deployment service already depends on the
   * domain service, and asking for it the other way in a constructor would be a
   * cycle. One question, one method.
   */
  domains.useReleases({ exists: (label) => deployments.releaseExists(label) });
  domains.usePreviewHosts(config.PREVIEW_HOST_SUFFIX);

  /*
   * Everything that changes a project tells the bus, and the socket gateway
   * listens to it.
   *
   * Introduced after construction rather than required in each constructor, as
   * the runtime service's own collaborators are, so that a service built for a
   * unit test has nobody listening and does not have to be handed a bus to say
   * so. An event is also not part of what any of these services are for: it is
   * how everybody else finds out.
   */
  const events = new ProjectEventBus(log);
  /*
   * Across processes, when there is more than one.
   *
   * Only with Redis configured, which is the same condition under which there
   * can usefully be several instances at all. Without it the bus is exactly
   * what it was: in-process, and correct for one instance.
   */
  const eventRelay = config.REDIS_URL
    ? new RedisEventRelay(config.REDIS_URL, events, log)
    : undefined;
  if (eventRelay) events.useRelay(eventRelay);
  files.useEvents(events);
  runtimes.useEvents(events);
  // So the log page can tail: it is told new lines exist and asks for them.
  logs.useEvents(events);
  snapshots.useEvents(events);
  gitService.useEvents(events);
  variables.useEvents(events);
  secrets.useEvents(events);
  databases.useEvents(events);
  databaseBackups.useEvents(events);
  members.useEvents(events);
  deployments.useEvents(events);
  domains.useEvents(events);

  /*
   * The application's own state, which already had a listener of its own.
   *
   * Bridged here rather than by giving the run service a bus, because it
   * already publishes exactly this and the output socket already consumes it.
   * Two listeners on one signal is the smaller change, and it keeps the run
   * service unaware that anything but the console cares.
   */
  runs.onRunChange(({ projectId, status, exitCode }) => {
    events.publish(projectId, { type: 'run.changed', status, exitCode });
  });

  const monitoring = new MonitoringService(
    new RuntimeRepository(database.client),
    new DeploymentRepository(database.client),
    execution,
    previews,
    deployments,
    new HealthCheckSettings(database.client),
    {
      sampleIntervalMs: config.MONITORING_SAMPLE_INTERVAL_MS,
      historySamples: config.MONITORING_HISTORY_SAMPLES,
      defaultHealthPath: config.HEALTH_CHECK_DEFAULT_PATH,
      defaultHealthTimeoutMs: config.HEALTH_CHECK_DEFAULT_TIMEOUT_MS,
    },
    log,
  );
  /*
   * The same ceilings the deployment provider was given.
   *
   * A usage bar drawn against the wrong limit is worse than no bar: it would
   * say a workload is comfortable when it is at its ceiling, or the reverse.
   */
  monitoring.useDeploymentLimits({
    cpuMillicores: config.DEPLOYMENT_CPU_MILLICORES,
    memoryMb: config.DEPLOYMENT_MEMORY_MB,
    pidsLimit: config.DEPLOYMENT_PIDS_LIMIT,
  });

  const alerts = new AlertService(
    new AlertRepository(database.client),
    monitoring,
    mail,
    {
      checkIntervalMs: config.ALERT_CHECK_INTERVAL_MS,
      batchSize: config.ALERT_BATCH,
      eventsShown: config.ALERT_EVENTS_SHOWN,
      publicUrl: config.WEB_PUBLIC_URL,
    },
    log,
  );

  /*
   * How much of the platform one account may be using at once.
   *
   * Introduced to the two services that can start something expensive, rather
   * than checked at their routes: the rule is "an account may have three
   * environments", and a route only knows about one project. Keeping it in one
   * place is what stops it being applied differently in two.
   */
  const quotas = new QuotaService(
    new QuotaRepository(database.client),
    {
      RUNTIMES: config.MAX_CONCURRENT_RUNTIMES_PER_USER,
      DEPLOYMENTS: config.MAX_CONCURRENT_DEPLOYMENTS_PER_USER,
      BUILDS: config.MAX_CONCURRENT_BUILDS_PER_USER,
    },
    log,
  );
  runtimes.useQuotas(quotas);
  deployments.useQuotas(quotas);

  const jobs = new JobService(
    new JobRepository(database.client),
    queue,
    { maxAttempts: config.JOB_MAX_ATTEMPTS, listLimit: config.JOB_LIST_LIMIT },
    log,
  );
  jobs.useEvents(events);

  /*
   * The slow halves, handed over.
   *
   * Both of these were written down as known problems the moment the features
   * existed: a first-time image pull and a dependency install each held a
   * request open for minutes. The services keep their inline path for an
   * installation with no worker, so this is a handover rather than a rewrite.
   */
  runtimes.useJobQueue(jobs);
  deployments.useJobQueue(jobs);

  /*
   * What the worker knows how to do.
   *
   * The payload is already validated against its schema before a handler sees
   * it, twice: once when the job was recorded and once when it was read back.
   * The cast is narrowing a checked shape rather than asserting an unchecked
   * one.
   */
  const handlers: Partial<Record<JobType, JobHandler>> = {
    RUNTIME_START: async (payload) => {
      const { runtimeId, actorId } = payload as { runtimeId: string; actorId: string };
      await runtimes.provisionRequested(runtimeId, actorId);
    },
    DEPLOYMENT_BUILD: async (payload) => {
      const { deploymentId, actorId } = payload as { deploymentId: string; actorId: string };
      await deployments.buildRequested(deploymentId, actorId);
    },
  };

  const worker = config.JOB_WORKER_ENABLED
    ? createJobWorker({
        jobs: new JobRepository(database.client, {
          concurrency: {
            RUNTIME_START: config.JOB_CONCURRENCY_RUNTIME_START,
            DEPLOYMENT_BUILD: config.JOB_CONCURRENCY_DEPLOYMENT_BUILD,
          },
        }),
        queue,
        handlers,
        /*
         * Told when work is given up on, so what was waiting stops waiting.
         *
         * A runtime whose start failed for the last time is otherwise left in
         * REQUESTED for ever, looking like it is about to happen. The job table
         * knows the job failed and has no idea what that meant.
         */
        onExhausted: async ({ type, payload, error }) => {
          if (type === 'RUNTIME_START') {
            const { runtimeId } = payload as { runtimeId: string };
            await runtimes.abandonRequested(runtimeId, error);
            return;
          }

          const { deploymentId } = payload as { deploymentId: string };
          await deployments.abandonRequested(deploymentId, error);
        },
        options: {
          concurrency: config.JOB_WORKER_CONCURRENCY,
          pollIntervalMs: config.JOB_POLL_INTERVAL_MS,
          retryBaseMs: config.JOB_RETRY_BASE_MS,
          retryMaxMs: config.JOB_RETRY_MAX_MS,
          jobTimeoutMs: config.JOB_TIMEOUT_MS,
          heartbeatMs: config.JOB_HEARTBEAT_MS,
          staleAfterMs: config.JOB_STALE_AFTER_MS,
          reapIntervalMs: config.JOB_REAP_INTERVAL_MS,
        },
        log,
      })
    : undefined;

  const projectService = new ProjectService(
    projects,
    { maxProjectsPerUser: config.MAX_PROJECTS_PER_USER },
    log,
  );
  // So deleting a project removes the database it was given, which lives in
  // another server and would otherwise be left with nobody able to say what it
  // was for.
  projectService.useDatabases(databases);
  // And the copies of it, which live in object storage where no cascade reaches.
  projectService.useDatabaseBackups(databaseBackups);
  // So deleting a project takes its snapshots with it. They live in object
  // storage, which no cascade reaches.
  projectService.useSnapshots(snapshots);
  // And its history, which is another archive no cascade reaches.
  projectService.useGit(gitService);
  // And anything it has deployed, which is held by a provider outside this
  // database entirely.
  projectService.useDeployments(deployments);
  // And its environment: the container, its shells, and its network.
  projectService.useRuntimes(runtimes);

  const account = new AccountService(
    users,
    new SessionRepository(database.client),
    projects,
    passwordHasher,
    { wrongPasswordDelayMs: config.ACCOUNT_WRONG_PASSWORD_DELAY_MS },
    log,
  );
  /*
   * So closing an account takes its projects down properly.
   *
   * The users row cascades to projects in the database, which would leave every
   * container, project database and stored archive behind with nothing naming
   * them. Deleting each project through the service first is what makes a
   * deletion actually a deletion.
   */
  account.useProjects(projectService);

  const twoFactor = new TwoFactorService(
    new TwoFactorRepository(database.client),
    users,
    new AccountTokenRepository(database.client),
    passwordHasher,
    box,
    {
      issuer: config.TWO_FACTOR_ISSUER,
      challengeTtlMinutes: 5,
      maxChallengeAttempts: 5,
      recoveryCodeCount: 10,
    },
    log,
  );

  const verification = new VerificationService(
    new AccountTokenRepository(database.client),
    users,
    new SessionRepository(database.client),
    mail,
    passwordHasher,
    {
      verificationTtlMinutes: config.EMAIL_VERIFICATION_TTL_MINUTES,
      resetTtlMinutes: config.PASSWORD_RESET_TTL_MINUTES,
      maxPerWindow: config.MAIL_TOKENS_PER_WINDOW,
      windowMinutes: config.MAIL_TOKEN_WINDOW_MINUTES,
      // Where a link points. The public address of the browser application,
      // which is not necessarily where this process is listening.
      publicUrl: config.WEB_PUBLIC_URL,
    },
    log,
  );

  /*
   * The other half of every "log it and carry on" decision in this codebase.
   *
   * Given the providers rather than the services above them on purpose: it
   * compares what the machines are holding against what the rows say, and a
   * service is the wrong altitude for that — it would answer from the rows,
   * which are the half that is known to be incomplete.
   */
  /*
   * Given repositories rather than services, deliberately.
   *
   * The services above them refuse illegal moves, enforce quotas, announce
   * events and charge things to an actor — all correct for a person pressing a
   * button, all wrong for a boot correcting a record nobody asked it to touch.
   * Recovery is not doing what a service does; it is writing down what is
   * already true.
   */
  const recovery = new StartupRecovery(
    new RecoveryRepository(database.client),
    new RuntimeRepository(database.client),
    new DeploymentRepository(database.client),
    new JobRepository(database.client),
    execution,
    userDatabases,
    { jobStaleAfterMs: config.JOB_STALE_AFTER_MS, timeoutMs: config.RECOVERY_TIMEOUT_MS },
    log,
  );

  const maintenance = new OrphanSweeper(
    new MaintenanceRepository(database.client),
    execution,
    storage,
    userDatabases,
    {
      graceMs: config.ORPHAN_GRACE_MINUTES * 60_000,
      dryRun: config.ORPHAN_SWEEP_DRY_RUN,
    },
    log,
  );

  /*
   * Given the sweeper and the placement source rather than its own copies.
   *
   * An operator running a sweep must run the same sweep the timer runs, and see
   * the same host load the scheduler places against. Two of either would be two
   * answers to one question, and the operations page is where somebody goes
   * precisely because they do not trust what they are being told.
   */
  const operations = new OperationsService(
    new OperationsRepository(database.client),
    placement,
    execution,
    maintenance,
    {
      hosts: resolveHosts(config),
      defaultHost: resolveHosts(config)[0]?.name ?? 'default',
      deploymentLimits: {
        cpuMillicores: config.DEPLOYMENT_CPU_MILLICORES,
        memoryMb: config.DEPLOYMENT_MEMORY_MB,
      },
      accountPageSize: config.OPERATIONS_PAGE_SIZE,
    },
    log,
  );
  operations.useQuotas(quotas);

  const sessions = new SessionService(
    new SessionRepository(database.client),
    {
      absoluteTtlHours: config.SESSION_ABSOLUTE_TTL_HOURS,
      idleTtlHours: config.SESSION_IDLE_TTL_HOURS,
      lastSeenThrottleSeconds: config.SESSION_LAST_SEEN_THROTTLE_SECONDS,
    },
    log,
  );

  return {
    sessions,
    projects,
    files,
    documents,
    members,
    runtimes,
    runs,
    terminals,
    previews,
    assets,
    secrets,
    variables,
    databases,
    databaseBackups,
    deployments,
    domains,
    logs,
    monitoring,
    alerts,
    jobs,
    quotas,
    ...(worker ? { worker } : {}),
    maintenance,
    recovery,
    account,
    verification,
    operations,
    twoFactor,
    ...(eventRelay ? { eventRelay } : {}),
    snapshots,
    git: gitService,
    restore,
    events,
    projectService,
    authorization: new AuthorizationService(projects),
    registration: new RegistrationService(users, passwordHasher, log),
    authentication: withTwoFactor(
      new AuthenticationService(users, sessions, passwordHasher, log),
      twoFactor,
    ),
  };
}

/**
 * Assembles the Express application.
 *
 * Kept separate from listening so tests can drive it in-process via supertest
 * without binding a port.
 */
export function createApp(deps: AppDependencies): Express {
  const { config } = deps;
  const app = express();

  app.disable('x-powered-by');
  // Without this, Express ignores X-Forwarded-For, so a client cannot escape
  // its own rate limit by inventing one. With it, only a trusted proxy's
  // header is honoured.
  if (config.TRUST_PROXY) app.set('trust proxy', true);

  app.use(requestContext());
  if (deps.metrics) app.use(deps.metrics.middleware());
  app.use(
    pinoHttp({
      logger: logger(),
      genReqId: (req) => (req as express.Request).requestId,
      autoLogging: { ignore: (req) => req.url?.startsWith('/health') === true },
      // Bodies on these routes carry passwords, and the cookie header carries
      // a live session token. Neither is ever logged.
      redact: { paths: ['req.body', 'res.body', 'req.headers.cookie'], remove: true },
    }),
  );

  app.use(helmet());
  /*
   * Four headers that depend on knowing what this surface is.
   *
   * Helmet has to be safe for an application that might serve HTML; this one
   * never does, which is what makes a policy forbidding everything the correct
   * policy rather than an aggressive one.
   */
  app.use(securityHeaders());

  /*
   * A ceiling on how long an ordinary request may take.
   *
   * The server's own request timeout is disabled on purpose — this process
   * holds WebSocket upgrades and streams output, and a connection-level timeout
   * would cut a terminal off mid-session. That left every ordinary request with
   * no ceiling at all. A response that has already started is exempt, because
   * an archive download takes as long as the archive is big.
   */
  app.use(requestTimeout({ timeoutMs: config.REQUEST_TIMEOUT_MS, log: logger() }));

  app.use(
    cors({
      origin: config.CORS_ORIGINS,
      credentials: true,
    }),
  );

  // Second layer behind the cookie's SameSite attribute. See origin-check.ts
  // for why both exist.
  app.use(checkOrigin(config.CORS_ORIGINS));

  // Bounded so a malformed or hostile body cannot exhaust memory. File
  // content arrives through its own route with its own limit.
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));

  // Unsigned: the token is 256 bits of randomness stored as a digest, so a
  // signature would add work without adding a guarantee.
  app.use(cookieParser());

  app.use('/health', healthRoutes(deps.health));

  if (deps.auth) {
    // Runs before the routes so any handler can ask who the caller is. It
    // never rejects; requireAuth does that, per route.
    app.use(attachSession(deps.auth.sessions, deps.cookie));

    /*
     * A ceiling on request rate, for the whole API.
     *
     * The specific limits below protect the endpoints an attacker hits hardest
     * — registration, sign-in, project creation — and say nothing about the
     * hundred other routes. This one is deliberately loose: it is not shaping
     * traffic, only stopping one client from making the platform unusable for
     * everybody else while somebody notices.
     *
     * After the session is attached, so it can be keyed by **account** where
     * there is one. An account is the more meaningful unit and much the harder
     * of the two to acquire in quantity; an address is what is left before
     * anybody has signed in.
     *
     * Mounted under `/api` rather than globally, which leaves `/health`
     * exempt. That is deliberate: the thing that polls it is a monitor, it is
     * the cheapest route here, and rate-limiting the endpoint an operator uses
     * to find out whether the platform is coping would be exactly backwards.
     */
    app.use(
      '/api',
      rateLimit({
        bucket: 'api',
        store: deps.rateLimitStore,
        max: config.RATE_LIMIT_GLOBAL_MAX,
        windowMs: config.RATE_LIMIT_GLOBAL_WINDOW_MS,
        keyOf: (req: express.Request) => req.auth?.user.id ?? req.ip ?? 'unknown',
      }),
    );

    app.use(
      '/api/auth',
      authRoutes({
        registration: deps.auth.registration,
        authentication: deps.auth.authentication,
        sessions: deps.auth.sessions,
        cookie: deps.cookie,
        rateLimitStore: deps.rateLimitStore,
        registerMax: config.RATE_LIMIT_REGISTER_MAX,
        registerWindowMs: config.RATE_LIMIT_REGISTER_WINDOW_MS,
        loginMax: config.RATE_LIMIT_LOGIN_MAX,
        loginWindowMs: config.RATE_LIMIT_LOGIN_WINDOW_MS,
        verification: deps.auth.verification,
        mailMax: config.RATE_LIMIT_MAIL_MAX,
        mailWindowMs: config.RATE_LIMIT_MAIL_WINDOW_MS,
      }),
    );

    /*
     * Not under a project, unlike almost everything else.
     *
     * The ceiling is per account, and a page that had to pick a project in
     * order to ask how much of the platform it was using would be asking the
     * wrong question.
     */
    app.use('/api/quotas', requireAuth(), quotaRoutes({ quotas: deps.auth.quotas }));

    /*
     * The installation, for the people who run it.
     *
     * Mounted like any other module and guarded inside, so there is no special
     * case here to forget. Nothing under this path reaches a project's contents.
     */
    app.use('/api/operations', operationsRoutes({ operations: deps.auth.operations }));

    /*
     * Also not under a project: this is the account itself.
     *
     * Every route inside is about the caller and nobody else. There is no
     * administrative path into it, which is why nothing here takes a user
     * identifier — the only identifier any of these routes accepts is a session
     * id, and it is matched against the caller's own account inside the query
     * that finds it.
     */
    app.use(
      '/api/account',
      accountRoutes({
        account: deps.auth.account,
        twoFactor: deps.auth.twoFactor,
        cookie: deps.cookie,
        rateLimitStore: deps.rateLimitStore,
        sensitiveMax: config.RATE_LIMIT_ACCOUNT_MAX,
        sensitiveWindowMs: config.RATE_LIMIT_ACCOUNT_WINDOW_MS,
      }),
    );

    app.use(
      '/api/projects',
      projectRoutes({
        projects: deps.auth.projects,
        service: deps.auth.projectService,
        members: deps.auth.members,
        authorization: deps.auth.authorization,
        rateLimitStore: deps.rateLimitStore,
        createMax: config.RATE_LIMIT_PROJECT_CREATE_MAX,
        createWindowMs: config.RATE_LIMIT_PROJECT_CREATE_WINDOW_MS,
      }),
    );

    // Nested under a project so every file request is authorized against one.
    app.use(
      '/api/projects/:projectId/files',
      requireAuth(),
      fileRoutes({ files: deps.auth.files, authorization: deps.auth.authorization }),
    );

    app.use(
      '/api/projects/:projectId/preview',
      requireAuth(),
      previewRoutes({ previews: deps.auth.previews, authorization: deps.auth.authorization }),
    );

    app.use(
      '/api/projects/:projectId/assets',
      requireAuth(),
      assetRoutes({
        assets: deps.auth.assets,
        authorization: deps.auth.authorization,
        maxAssetBytes: config.ASSET_MAX_BYTES,
      }),
    );

    app.use(
      '/api/projects/:projectId/secrets',
      requireAuth(),
      secretRoutes({ secrets: deps.auth.secrets, authorization: deps.auth.authorization }),
    );

    app.use(
      '/api/projects/:projectId/git',
      requireAuth(),
      gitRoutes({
        git: deps.auth.git,
        restore: deps.auth.restore,
        authorization: deps.auth.authorization,
      }),
    );

    app.use(
      '/api/projects/:projectId/snapshots',
      requireAuth(),
      snapshotRoutes({
        snapshots: deps.auth.snapshots,
        restore: deps.auth.restore,
        authorization: deps.auth.authorization,
      }),
    );

    app.use(
      '/api/projects/:projectId/database',
      requireAuth(),
      databaseRoutes({
        databases: deps.auth.databases,
        backups: deps.auth.databaseBackups,
        runtimes: deps.auth.runtimes,
        authorization: deps.auth.authorization,
      }),
    );

    app.use(
      '/api/projects/:projectId/domains',
      requireAuth(),
      domainRoutes({ domains: deps.auth.domains, authorization: deps.auth.authorization }),
    );

    app.use(
      '/api/projects/:projectId/jobs',
      requireAuth(),
      jobRoutes({
        jobs: deps.auth.jobs,
        // Only this process is known. A worker running elsewhere cannot be seen
        // from here, so the page says "not by me" rather than "nothing".
        workerRunning: () => deps.auth?.worker?.running ?? false,
        authorization: deps.auth.authorization,
      }),
    );

    app.use(
      '/api/projects/:projectId/monitoring',
      requireAuth(),
      monitoringRoutes({
        monitoring: deps.auth.monitoring,
        authorization: deps.auth.authorization,
      }),
    );

    app.use(
      '/api/projects/:projectId/alerts',
      requireAuth(),
      alertRoutes({ alerts: deps.auth.alerts, authorization: deps.auth.authorization }),
    );

    app.use(
      '/api/projects/:projectId/logs',
      requireAuth(),
      logRoutes({ logs: deps.auth.logs, authorization: deps.auth.authorization }),
    );

    app.use(
      '/api/projects/:projectId/deployments',
      requireAuth(),
      deploymentRoutes({
        deployments: deps.auth.deployments,
        authorization: deps.auth.authorization,
      }),
    );

    app.use(
      '/api/projects/:projectId/variables',
      requireAuth(),
      variableRoutes({
        variables: deps.auth.variables,
        secrets: deps.auth.secrets,
        runtimes: deps.auth.runtimes,
        authorization: deps.auth.authorization,
      }),
    );

    app.use(
      '/api/projects/:projectId/runtime',
      requireAuth(),
      runtimeRoutes({
        runtimes: deps.auth.runtimes,
        runs: deps.auth.runs,
        terminals: deps.auth.terminals,
        authorization: deps.auth.authorization,
        rateLimitStore: deps.rateLimitStore,
        controlMax: config.RATE_LIMIT_RUNTIME_CONTROL_MAX,
        controlWindowMs: config.RATE_LIMIT_RUNTIME_CONTROL_WINDOW_MS,
      }),
    );
  }

  /*
   * The reverse proxy's certificate question, outside the authenticated API.
   *
   * Asked during an inbound TLS handshake, by the proxy rather than by a
   * person, so there is no session to attach and nothing to authorize against.
   * It answers yes or no about one hostname, which discloses only what anybody
   * could learn by connecting to that hostname anyway.
   *
   * It should still be reachable only from the proxy. That is a deployment
   * decision, and it is written down in the Caddyfile beside the directive that
   * calls this.
   */
  if (deps.auth) {
    app.use(
      '/internal/tls-authorize',
      certificateAuthorizationRoutes({ domains: deps.auth.domains }),
    );
  }

  /*
   * The platform's own metrics, for a scraper inside the deployment.
   *
   * Not under /api, and never routed by the production proxy. Answers 404 unless
   * METRICS_TOKEN is set and presented as a bearer token.
   */
  if (deps.metrics) app.get('/metrics', deps.metrics.handler(config.METRICS_TOKEN));

  app.use(notFoundHandler());
  app.use(errorHandler());

  return app;
}

/** Sign-in, told about the second factor. A function so the wiring reads as one line above. */
function withTwoFactor(
  authentication: AuthenticationService,
  twoFactor: TwoFactorService,
): AuthenticationService {
  authentication.useTwoFactor(twoFactor);
  return authentication;
}
