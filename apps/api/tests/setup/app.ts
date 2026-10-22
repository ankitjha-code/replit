import type { Express } from 'express';
import { pino, type Logger } from 'pino';
import { createApp, type AppDependencies, type AuthDependencies } from '../../src/app.js';
import { loadEnv, type Env } from '../../src/config/env.js';
import { MemoryRateLimitStore } from '../../src/http/middleware/rate-limit.js';
import { sessionCookieSettings } from '../../src/http/session-cookie.js';
import { HealthService } from '../../src/modules/health/health.service.js';
import { AuthenticationService } from '../../src/modules/auth/authentication.service.js';
import { RegistrationService } from '../../src/modules/auth/registration.service.js';
import { SessionService } from '../../src/modules/auth/session.service.js';
import { FileRepository } from '../../src/modules/files/file.repository.js';
import { DEFAULT_FILE_OPTIONS, FileService } from '../../src/modules/files/file.service.js';
import { AuthorizationService } from '../../src/modules/projects/authorization.service.js';
import { ProjectRepository } from '../../src/modules/projects/project.repository.js';
import { ProjectService } from '../../src/modules/projects/project.service.js';
import { AccountService } from '../../src/modules/account/account.service.js';
import { TwoFactorRepository } from '../../src/modules/two-factor/two-factor.repository.js';
import { TwoFactorService } from '../../src/modules/two-factor/two-factor.service.js';
import { AccountTokenRepository } from '../../src/modules/verification/token.repository.js';
import { VerificationService } from '../../src/modules/verification/verification.service.js';
import { OperationsRepository } from '../../src/modules/operations/operations.repository.js';
import { OperationsService } from '../../src/modules/operations/operations.service.js';
import { DatabasePlacementSource } from '../../src/execution/placement-source.js';
import { resolveHosts } from '../../src/execution/create-provider.js';
import { MaintenanceRepository } from '../../src/modules/maintenance/maintenance.repository.js';
import { OrphanSweeper } from '../../src/modules/maintenance/orphan-sweeper.js';
import { RecoveryRepository } from '../../src/lifecycle/recovery.repository.js';
import { StartupRecovery } from '../../src/lifecycle/recovery.js';
import { SessionRepository } from '../../src/modules/sessions/session.repository.js';
import { UserRepository } from '../../src/modules/users/user.repository.js';
import type { PasswordHasher } from '../../src/lib/password.js';
import type { Database } from '../../src/db/client.js';
import type { ExecutionProvider } from '../../src/execution/provider.js';
import { UnavailableExecutionProvider } from '../../src/execution/unavailable-provider.js';
import type { StorageProvider } from '../../src/storage/provider.js';
import { UnavailableStorageProvider } from '../../src/storage/unavailable-storage.js';
import { UnavailableMailProvider } from '../../src/mail/unavailable-mail.js';
import type { MailProvider } from '../../src/mail/provider.js';
import { AssetRepository } from '../../src/modules/assets/asset.repository.js';
import { SecretRepository } from '../../src/modules/secrets/secret.repository.js';
import { SecretService } from '../../src/modules/secrets/secret.service.js';
import { createKeyRing, parseEncryptionKey, parsePreviousKeys } from '../../src/lib/secret-box.js';
import { AssetService } from '../../src/modules/assets/asset.service.js';
import { PreviewGrantRepository } from '../../src/modules/preview/preview.repository.js';
import { PreviewService } from '../../src/modules/preview/preview.service.js';
import { RuntimeRepository } from '../../src/modules/runtimes/runtime.repository.js';
import { RunService } from '../../src/modules/runtimes/run.service.js';
import { TerminalSessionService } from '../../src/modules/runtimes/terminal-session.service.js';
import { TerminalRepository } from '../../src/modules/runtimes/terminal.repository.js';
import { BackupRepository } from '../../src/modules/databases/backup.repository.js';
import { BackupService } from '../../src/modules/databases/backup.service.js';
import { VariableRepository } from '../../src/modules/variables/variable.repository.js';
import { DatabaseRepository } from '../../src/modules/databases/database.repository.js';
import { DatabaseService } from '../../src/modules/databases/database.service.js';
import { GitRemoteStore, GitRepositoryStore } from '../../src/modules/git/git.repository.js';
import { GitService } from '../../src/modules/git/git.service.js';
import { SnapshotRepository } from '../../src/modules/snapshots/snapshot.repository.js';
import { SnapshotService } from '../../src/modules/snapshots/snapshot.service.js';
import { RestoreService } from '../../src/modules/restore/restore.service.js';
import { DocumentSessionService } from '../../src/modules/documents/document-session.service.js';
import { MembershipService } from '../../src/modules/projects/membership.service.js';
import { DomainRepository } from '../../src/modules/domains/domain.repository.js';
import { DomainService } from '../../src/modules/domains/domain.service.js';
import { LogRepository } from '../../src/modules/logs/log.repository.js';
import { LogService } from '../../src/modules/logs/log.service.js';
import { MonitoringService } from '../../src/modules/monitoring/monitoring.service.js';
import { AlertRepository } from '../../src/modules/alerts/alert.repository.js';
import { AlertService } from '../../src/modules/alerts/alert.service.js';
import { JobRepository } from '../../src/modules/jobs/job.repository.js';
import { JobService } from '../../src/modules/jobs/job.service.js';
import { QuotaRepository } from '../../src/modules/quotas/quota.repository.js';
import { QuotaService } from '../../src/modules/quotas/quota.service.js';
import { InMemoryJobQueue } from '../../src/jobs/memory-queue.js';
import { HealthCheckSettings } from '../../src/modules/monitoring/monitoring.repository.js';
import { DeploymentRepository } from '../../src/modules/deployments/deployment.repository.js';
import { DeploymentService } from '../../src/modules/deployments/deployment.service.js';
import { UnavailableDeploymentProvider } from '../../src/deploy/unavailable-provider.js';
import type { DeploymentProvider } from '../../src/deploy/provider.js';
import { ProjectEventBus } from '../../src/events/project-event-bus.js';
import { createUserDatabaseProvider } from '../../src/userdb/create-provider.js';
import { UnavailableUserDatabaseProvider } from '../../src/userdb/unavailable-provider.js';
import type { UserDatabaseProvider } from '../../src/userdb/provider.js';
import { VariableService } from '../../src/modules/variables/variable.service.js';
import { RuntimeService } from '../../src/modules/runtimes/runtime.service.js';

/**
 * A password hasher that does no key derivation.
 *
 * The real Argon2 parameters cost 19 MiB and tens of milliseconds per call by
 * design. A suite that registers dozens of users would spend most of its time
 * proving Argon2 works, which is Argon2's own test suite's job. The real
 * hasher is covered directly in its own unit tests.
 */
export class FakePasswordHasher implements PasswordHasher {
  readonly hashed: string[] = [];
  /** Set to make every stored hash look outdated, exercising the rehash path. */
  rehashNeeded = false;

  hash(plaintext: string): Promise<string> {
    this.hashed.push(plaintext);
    return Promise.resolve(`fake$${Buffer.from(plaintext).toString('base64url')}`);
  }

  verify(hashValue: string, plaintext: string): Promise<boolean> {
    return Promise.resolve(hashValue === `fake$${Buffer.from(plaintext).toString('base64url')}`);
  }

  needsRehash(): boolean {
    return this.rehashNeeded;
  }
}

export const silentLogger = (): Logger => pino({ level: 'silent' });

/** Builds the auth services against a real database client. */
export function testAuth(
  db: Database,
  config: Env,
  hasher: PasswordHasher,
  log: Logger = silentLogger(),
  /** Defaults to the same refusal a real installation with no backend gives. */
  execution: ExecutionProvider = new UnavailableExecutionProvider(),
  storage: StorageProvider = new UnavailableStorageProvider(),
  /**
   * Where project databases come from.
   *
   * Undefined means "whatever this configuration implies", which is a real
   * server when USER_DATABASE_ADMIN_URL is set and an honest refusal when it is
   * not. Suites that want neither pass their own.
   */
  userDatabases?: UserDatabaseProvider,
  /**
   * Where mail goes.
   *
   * Defaults to the provider that refuses, which is what an installation
   * without a mail server actually has. A suite that wants to watch a message
   * being composed passes its own.
   */
  mail: MailProvider = new UnavailableMailProvider(),
  /**
   * Where deployments are built and served. Defaults to the provider that
   * refuses; the deployment suite passes a fake that behaves like a real one.
   */
  deploymentProvider: DeploymentProvider = new UnavailableDeploymentProvider(),
): AuthDependencies {
  const users = new UserRepository(db);
  const projects = new ProjectRepository(db);
  const files = new FileService(
    new FileRepository(db),
    {
      ...DEFAULT_FILE_OPTIONS,
      maxFileBytes: config.FILE_MAX_BYTES,
      maxProjectBytes: config.PROJECT_MAX_BYTES,
      maxEntries: config.PROJECT_MAX_FILES,
    },
    log,
  );
  const sessions = new SessionService(
    new SessionRepository(db),
    {
      absoluteTtlHours: config.SESSION_ABSOLUTE_TTL_HOURS,
      idleTtlHours: config.SESSION_IDLE_TTL_HOURS,
      lastSeenThrottleSeconds: config.SESSION_LAST_SEEN_THROTTLE_SECONDS,
    },
    log,
  );

  const encryptionKey = parseEncryptionKey(config.SECRETS_ENCRYPTION_KEY);
  // A ring rather than a single key, so a rotation can be in progress: new
  // values sealed with the current key, old ones still readable.
  const box = encryptionKey
    ? createKeyRing(encryptionKey, parsePreviousKeys(config.SECRETS_PREVIOUS_KEYS))
    : undefined;
  const variableRepository = new VariableRepository(db);
  const secretRepository = new SecretRepository(db);
  const databaseRepository = new DatabaseRepository(db);

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
  // Resolved once. Two call sites each defaulting separately would be two
  // different providers in one graph, which is exactly the kind of thing a
  // fixture is supposed to make impossible rather than likely.
  const userDatabaseProvider = userDatabases ?? createUserDatabaseProvider(config, log);

  const databases = new DatabaseService(
    databaseRepository,
    userDatabaseProvider,
    box,
    variableRepository,
    secretRepository,
    {
      containerHost: config.USER_DATABASE_CONTAINER_HOST,
      containerPort: config.USER_DATABASE_CONTAINER_PORT,
    },
    log,
  );

  const runtimes = new RuntimeService(
    new RuntimeRepository(db),
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
    new RuntimeRepository(db),
    new PreviewGrantRepository(db),
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

  const runs = new RunService(
    new RuntimeRepository(db),
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
    new TerminalRepository(db),
    {
      maxPerProject: config.MAX_TERMINALS_PER_PROJECT,
      scrollbackBytes: config.TERMINAL_SCROLLBACK_BYTES,
      idleMs: config.TERMINAL_SESSION_IDLE_MS,
    },
    log,
  );
  runtimes.useTerminalSessions(terminals);

  const assets = new AssetService(
    new AssetRepository(db),
    storage,
    {
      maxAssetBytes: config.ASSET_MAX_BYTES,
      maxProjectBytes: config.PROJECT_ASSET_MAX_BYTES,
    },
    log,
  );

  const snapshots = new SnapshotService(
    new SnapshotRepository(db),
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
    new GitRepositoryStore(db),
    files,
    storage,
    {
      historyLimit: config.GIT_HISTORY_LIMIT,
      maxRepositoryBytes: config.GIT_MAX_REPOSITORY_BYTES,
    },
    log,
  );

  gitService.useRemotes(new GitRemoteStore(db), box, {
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
    new LogRepository(db),
    {
      retainedLines: config.PROJECT_LOG_RETAINED_LINES,
      flushIntervalMs: config.PROJECT_LOG_FLUSH_MS,
      flushLines: config.PROJECT_LOG_FLUSH_LINES,
    },
    log,
  );
  runs.useLogs(logs);

  const domains = new DomainService(
    new DomainRepository(db),
    {
      hostSuffix: config.DEPLOYMENT_HOST_SUFFIX,
      scheme: config.DEPLOYMENT_SCHEME,
      maxPerProject: config.MAX_DOMAINS_PER_PROJECT,
      dnsTimeoutMs: config.DOMAIN_DNS_TIMEOUT_MS,
      dnsServers: config.DOMAIN_DNS_SERVERS,
      customDomainsUnavailableReason: null,
    },
    log,
  );
  domains.usePreviewHosts(config.PREVIEW_HOST_SUFFIX);

  const deployments = new DeploymentService(
    new DeploymentRepository(db),
    files,
    snapshots,
    storage,
    deploymentProvider,
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

  // Wired exactly as the application wires it, so a test drives the same graph
  // rather than a similar one.
  const events = new ProjectEventBus(log);
  files.useEvents(events);
  runtimes.useEvents(events);
  logs.useEvents(events);
  snapshots.useEvents(events);
  gitService.useEvents(events);
  variables.useEvents(events);
  secrets.useEvents(events);
  databases.useEvents(events);
  members.useEvents(events);
  deployments.useEvents(events);
  domains.useEvents(events);
  runs.onRunChange(({ projectId, status, exitCode }) => {
    events.publish(projectId, { type: 'run.changed', status, exitCode });
  });

  const monitoring = new MonitoringService(
    new RuntimeRepository(db),
    new DeploymentRepository(db),
    execution,
    previews,
    deployments,
    new HealthCheckSettings(db),
    {
      sampleIntervalMs: config.MONITORING_SAMPLE_INTERVAL_MS,
      historySamples: config.MONITORING_HISTORY_SAMPLES,
      defaultHealthPath: config.HEALTH_CHECK_DEFAULT_PATH,
      defaultHealthTimeoutMs: config.HEALTH_CHECK_DEFAULT_TIMEOUT_MS,
    },
    log,
  );
  monitoring.useDeploymentLimits({
    cpuMillicores: config.DEPLOYMENT_CPU_MILLICORES,
    memoryMb: config.DEPLOYMENT_MEMORY_MB,
    pidsLimit: config.DEPLOYMENT_PIDS_LIMIT,
  });

  const alerts = new AlertService(
    new AlertRepository(db),
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
   * A job service with an in-process queue and no worker.
   *
   * Deliberately no worker: a suite that started one would have background work
   * racing its assertions, and every integration test here asserts on what a
   * request did rather than on what happened afterwards. The services keep their
   * inline path, so what the tests drive is the same code with the handover
   * skipped.
   */
  const quotas = new QuotaService(
    new QuotaRepository(db),
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
    new JobRepository(db),
    new InMemoryJobQueue(),
    { maxAttempts: config.JOB_MAX_ATTEMPTS, listLimit: config.JOB_LIST_LIMIT },
    log,
  );
  jobs.useEvents(events);

  const projectService = new ProjectService(
    projects,
    { maxProjectsPerUser: config.MAX_PROJECTS_PER_USER },
    log,
  );
  projectService.useDatabases(databases);
  projectService.useSnapshots(snapshots);
  projectService.useGit(gitService);
  projectService.useDeployments(deployments);
  // And its environment: the container, its shells, and its network.
  projectService.useRuntimes(runtimes);

  /*
   * The account, cleanup and recovery, built the same way the real graph builds
   * them.
   *
   * Constructed rather than stubbed even though most suites never touch them:
   * a fixture that omitted them would be a second, smaller dependency graph, and
   * the first thing a smaller graph hides is a service that quietly stopped
   * being wired to something.
   */
  const databaseBackups = new BackupService(
    new BackupRepository(db),
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

  const account = new AccountService(
    users,
    new SessionRepository(db),
    projects,
    hasher,
    { wrongPasswordDelayMs: 0 },
    log,
  );
  account.useProjects(projectService);

  const maintenance = new OrphanSweeper(
    new MaintenanceRepository(db),
    execution,
    storage,
    userDatabaseProvider,
    { graceMs: config.ORPHAN_GRACE_MINUTES * 60_000, dryRun: config.ORPHAN_SWEEP_DRY_RUN },
    log,
  );

  const twoFactor = new TwoFactorService(
    new TwoFactorRepository(db),
    users,
    new AccountTokenRepository(db),
    hasher,
    box,
    { issuer: 'Platform', challengeTtlMinutes: 5, maxChallengeAttempts: 5, recoveryCodeCount: 10 },
    log,
  );

  const verification = new VerificationService(
    new AccountTokenRepository(db),
    users,
    new SessionRepository(db),
    mail,
    hasher,
    {
      verificationTtlMinutes: config.EMAIL_VERIFICATION_TTL_MINUTES,
      resetTtlMinutes: config.PASSWORD_RESET_TTL_MINUTES,
      maxPerWindow: config.MAIL_TOKENS_PER_WINDOW,
      windowMinutes: config.MAIL_TOKEN_WINDOW_MINUTES,
      publicUrl: config.WEB_PUBLIC_URL,
    },
    log,
  );

  const recovery = new StartupRecovery(
    new RecoveryRepository(db),
    new RuntimeRepository(db),
    new DeploymentRepository(db),
    new JobRepository(db),
    execution,
    userDatabaseProvider,
    { jobStaleAfterMs: config.JOB_STALE_AFTER_MS, timeoutMs: config.RECOVERY_TIMEOUT_MS },
    log,
  );

  const operations = new OperationsService(
    new OperationsRepository(db),
    new DatabasePlacementSource(db, {
      cpuMillicores: config.DEPLOYMENT_CPU_MILLICORES,
      memoryMb: config.DEPLOYMENT_MEMORY_MB,
    }),
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

  const authentication = new AuthenticationService(users, sessions, hasher, log);
  authentication.useTwoFactor(twoFactor);

  return {
    account,
    twoFactor,
    databaseBackups,
    verification,
    operations,
    maintenance,
    recovery,
    sessions,
    projects,
    files,
    documents,
    members,
    runtimes,
    runs,
    terminals,
    assets,
    variables,
    databases,
    deployments,
    domains,
    logs,
    monitoring,
    alerts,
    jobs,
    quotas,
    snapshots,
    git: gitService,
    restore,
    events,
    secrets,
    previews,
    projectService,
    authorization: new AuthorizationService(projects),
    registration: new RegistrationService(users, hasher, log),
    authentication,
  };
}

/** Builds a complete dependency set, overriding only what a test cares about. */
export function testDependencies(overrides: Partial<AppDependencies> = {}): AppDependencies {
  const config = overrides.config ?? loadEnv({} as NodeJS.ProcessEnv);

  return {
    config,
    health: new HealthService('api', '0.0.0-test'),
    execution: new UnavailableExecutionProvider(),
    storage: new UnavailableStorageProvider(),
    /*
     * No mail in tests, and the refusal is the point.
     *
     * The provider that cannot send is what an installation without a mail
     * server actually has, so a suite built on it exercises the path most
     * installations are on rather than a happy one nobody runs.
     */
    mail: new UnavailableMailProvider(),
    userDatabases: new UnavailableUserDatabaseProvider(),
    deployment: new UnavailableDeploymentProvider(),
    queue: new InMemoryJobQueue(),
    rateLimitStore: new MemoryRateLimitStore(),
    cookie: sessionCookieSettings(config),
    passwordHasher: new FakePasswordHasher(),
    ...overrides,
  };
}

export function testApp(overrides: Partial<AppDependencies> = {}): Express {
  return createApp(testDependencies(overrides));
}
