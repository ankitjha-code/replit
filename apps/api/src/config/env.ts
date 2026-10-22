import { z } from 'zod';

const portSchema = z.coerce.number().int().min(1).max(65535);

const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    return trimmed === '' ? undefined : trimmed;
  }, schema.optional());

const booleanish = z
  .union([z.boolean(), z.string()])
  .transform((v) =>
    typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase()),
  );

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  API_HOST: z.string().min(1).default('0.0.0.0'),
  API_PORT: portSchema.default(4000),

  API_PUBLIC_URL: z.url().default('http://localhost:4000'),

  WEB_PUBLIC_URL: z.url().default('http://localhost:5173'),

  CORS_ORIGINS: z
    .string()
    .default('http://localhost:5173')
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  LOG_PRETTY: booleanish.default(false),

  METRICS_TOKEN: z.string().min(24).optional(),

  TRUST_PROXY: booleanish.default(false),

  DATABASE_URL: optional(z.string().startsWith('postgres')),

  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  DATABASE_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(100).default(5_000),
  DATABASE_IDLE_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(30_000),
  DATABASE_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(100).default(15_000),

  REDIS_URL: optional(z.string().startsWith('redis')),

  RATE_LIMIT_REGISTER_MAX: z.coerce.number().int().min(1).default(5),
  RATE_LIMIT_REGISTER_WINDOW_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .default(15 * 60_000),

  RATE_LIMIT_LOGIN_MAX: z.coerce.number().int().min(1).default(10),
  RATE_LIMIT_LOGIN_WINDOW_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .default(15 * 60_000),

  RATE_LIMIT_ACCOUNT_MAX: z.coerce.number().int().min(1).default(5),
  RATE_LIMIT_ACCOUNT_WINDOW_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .default(15 * 60_000),
  ACCOUNT_WRONG_PASSWORD_DELAY_MS: z.coerce.number().int().min(0).max(10_000).default(400),

  RATE_LIMIT_MAIL_MAX: z.coerce.number().int().min(1).default(5),
  RATE_LIMIT_MAIL_WINDOW_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .default(15 * 60_000),

  RATE_LIMIT_PROJECT_CREATE_MAX: z.coerce.number().int().min(1).default(20),
  RATE_LIMIT_PROJECT_CREATE_WINDOW_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .default(60 * 60_000),

  MAX_PROJECTS_PER_USER: z.coerce.number().int().min(1).default(50),

  FILE_MAX_BYTES: z.coerce
    .number()
    .int()
    .min(1024)
    .default(1024 * 1024),

  PROJECT_MAX_BYTES: z.coerce
    .number()
    .int()
    .min(1024)
    .default(64 * 1024 * 1024),

  PROJECT_MAX_FILES: z.coerce.number().int().min(1).default(5_000),

  EXECUTION_PROVIDER: z.enum(['none', 'docker']).default('none'),

  DEPLOYMENT_PROVIDER: z.enum(['none', 'execution']).default('none'),

  MAX_DEPLOYMENTS_PER_PROJECT: z.coerce.number().int().min(1).max(200).default(20),

  DEPLOYMENT_MAX_ARTIFACT_BYTES: z.coerce
    .number()
    .int()
    .min(1024)
    .default(128 * 1024 * 1024),
  DEPLOYMENT_MAX_FILE_BYTES: z.coerce
    .number()
    .int()
    .min(1024)
    .default(32 * 1024 * 1024),
  DEPLOYMENT_MAX_FILES: z.coerce.number().int().min(1).default(20_000),

  DEPLOYMENT_BUILD_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(10_000)
    .default(15 * 60 * 1000),

  DEPLOYMENT_MAX_LOG_BYTES: z.coerce
    .number()
    .int()
    .min(1024)
    .default(256 * 1024),

  DEPLOYMENT_CPU_MILLICORES: z.coerce.number().int().min(100).max(64_000).default(1_000),
  DEPLOYMENT_MEMORY_MB: z.coerce.number().int().min(64).max(65_536).default(512),
  DEPLOYMENT_PIDS_LIMIT: z.coerce.number().int().min(16).max(10_000).default(256),

  DEPLOYMENT_READY_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(60_000),

  DEPLOYMENT_PROBE_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(1_000),

  PROJECT_LOG_RETAINED_LINES: z.coerce.number().int().min(100).max(1_000_000).default(20_000),

  PROJECT_LOG_FLUSH_MS: z.coerce.number().int().min(50).max(60_000).default(1_000),
  PROJECT_LOG_FLUSH_LINES: z.coerce.number().int().min(1).max(10_000).default(200),

  REDIS_JOB_CHANNEL: z.string().min(1).default('platform:jobs'),

  JOB_WORKER_ENABLED: z
    .string()
    .default('true')
    .transform((value) => value !== 'false'),

  JOB_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
  JOB_POLL_INTERVAL_MS: z.coerce.number().int().min(200).max(60_000).default(2_000),

  JOB_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(3),
  JOB_RETRY_BASE_MS: z.coerce.number().int().min(100).max(600_000).default(5_000),
  JOB_RETRY_MAX_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(120_000),

  JOB_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(10_000)
    .default(20 * 60 * 1000),

  JOB_HEARTBEAT_MS: z.coerce.number().int().min(500).max(120_000).default(10_000),
  JOB_STALE_AFTER_MS: z.coerce.number().int().min(5_000).max(3_600_000).default(60_000),

  JOB_REAP_INTERVAL_MS: z.coerce.number().int().min(1_000).max(600_000).default(30_000),

  JOB_CONCURRENCY_RUNTIME_START: z.coerce.number().int().min(0).max(1_000).default(0),
  JOB_CONCURRENCY_DEPLOYMENT_BUILD: z.coerce.number().int().min(0).max(1_000).default(0),
  ALERT_CHECK_INTERVAL_MS: z.coerce.number().int().min(10_000).max(3_600_000).default(60_000),
  ALERT_BATCH: z.coerce.number().int().min(1).max(1_000).default(50),
  ALERT_EVENTS_SHOWN: z.coerce.number().int().min(1).max(200).default(20),
  JOB_LIST_LIMIT: z.coerce.number().int().min(1).max(200).default(20),

  MONITORING_SAMPLE_INTERVAL_MS: z.coerce.number().int().min(1_000).max(300_000).default(5_000),
  MONITORING_HISTORY_SAMPLES: z.coerce.number().int().min(2).max(2_000).default(60),

  HEALTH_CHECK_DEFAULT_PATH: z.string().min(1).max(200).default('/'),
  HEALTH_CHECK_DEFAULT_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(3_000),

  MAX_DOMAINS_PER_PROJECT: z.coerce.number().int().min(1).max(50).default(5),

  DOMAIN_DNS_TIMEOUT_MS: z.coerce.number().int().min(200).max(30_000).default(5_000),
  DOMAIN_DNS_SERVERS: z
    .string()
    .default('')
    .transform((value) =>
      value
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0),
    ),

  DEPLOYMENT_PORT: z.coerce.number().int().min(1).max(65_535).default(4200),
  DEPLOYMENT_HOST_SUFFIX: z.string().default('localhost:4200'),
  DEPLOYMENT_SCHEME: z.enum(['http', 'https']).default('http'),

  DEPLOYMENT_STATIC_CACHE_BYTES: z.coerce
    .number()
    .int()
    .min(1024)
    .default(256 * 1024 * 1024),

  MAX_SOCKETS_PER_USER: z.coerce.number().int().min(1).max(1_000).default(40),

  MAX_SOCKET_ATTEMPTS: z.coerce.number().int().min(1).max(10_000).default(120),
  SOCKET_ATTEMPT_WINDOW_MS: z.coerce.number().int().min(1_000).default(60_000),

  SOCKET_MESSAGE_BURST: z.coerce.number().int().min(1).max(100_000).default(200),
  SOCKET_MESSAGES_PER_SECOND: z.coerce.number().int().min(1).max(10_000).default(50),

  RATE_LIMIT_GLOBAL_MAX: z.coerce.number().int().min(1).default(600),
  RATE_LIMIT_GLOBAL_WINDOW_MS: z.coerce.number().int().min(1_000).default(60_000),

  REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(600_000).default(30_000),

  MAX_CONCURRENT_RUNTIMES_PER_USER: z.coerce.number().int().min(1).max(1_000).default(3),
  MAX_CONCURRENT_DEPLOYMENTS_PER_USER: z.coerce.number().int().min(1).max(1_000).default(5),

  MAX_CONCURRENT_BUILDS_PER_USER: z.coerce.number().int().min(1).max(100).default(2),

  EXECUTION_HOSTS: optional(z.string().min(1)),

  MAX_WORKLOADS_PER_HOST: z.coerce.number().int().min(1).max(1_000).default(20),

  RUNTIME_MAX_OPEN_FILES: z.coerce.number().int().min(256).max(1_048_576).default(8_192),

  RUNTIME_DISK_MB: z.coerce.number().int().min(64).max(1_000_000).default(2_048),
  DEPLOYMENT_DISK_MB: z.coerce.number().int().min(64).max(1_000_000).default(2_048),
  DISK_CHECK_INTERVAL_MS: z.coerce.number().int().min(5_000).max(3_600_000).default(60_000),
  DISK_LIMIT_MODE: z.enum(['monitor', 'enforce']).default('monitor'),
  RUNTIME_OCI_RUNTIME: z
    .string()
    .regex(/^[a-z0-9_-]{1,32}$/)
    .optional(),
  RUNTIME_TMP_MB: z.coerce.number().int().min(16).max(16_384).default(256),

  DOCKER_SOCKET_PATH: optional(z.string().min(1)),

  RUNTIME_NETWORK: z.string().min(1).default('platform-runtimes'),

  RUNTIME_WORKSPACE_PATH: z.string().startsWith('/').default('/workspace'),

  RUNTIME_IMAGE_PULL_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .default(5 * 60_000),

  RUNTIME_AVAILABILITY_TTL_MS: z.coerce.number().int().min(0).default(5_000),

  RUNTIME_CPU_MILLICORES: z.coerce.number().int().min(100).max(8_000).default(1_000),
  RUNTIME_MEMORY_MB: z.coerce.number().int().min(128).max(16_384).default(1_024),
  RUNTIME_PIDS_LIMIT: z.coerce.number().int().min(16).max(4_096).default(256),

  RUNTIME_STOP_GRACE_SECONDS: z.coerce.number().int().min(1).max(120).default(10),

  PREVIEW_PORT: portSchema.default(4100),

  PREVIEW_HOST_SUFFIX: z.string().min(1).default('localhost:4100'),

  PREVIEW_SCHEME: z.enum(['http', 'https']).default('http'),

  PREVIEW_COOKIE_NAME: z.string().min(1).default('platform_preview'),

  PREVIEW_GRANT_TTL_SECONDS: z.coerce.number().int().min(5).max(600).default(60),

  PREVIEW_SESSION_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(60)
    .default(8 * 60 * 60),

  PREVIEW_PROBE_TIMEOUT_MS: z.coerce.number().int().min(50).max(10_000).default(1_000),

  RUN_OUTPUT_BUFFER_BYTES: z.coerce
    .number()
    .int()
    .min(1024)
    .default(256 * 1024),
  RUN_OUTPUT_BUFFER_LINES: z.coerce.number().int().min(10).default(2_000),

  MAX_OUTPUT_WATCHERS_PER_PROJECT: z.coerce.number().int().min(1).max(100).default(10),

  MAX_OPEN_DOCUMENTS_PER_PROJECT: z.coerce.number().int().min(1).max(200).default(20),

  MAX_DOCUMENT_EDITORS_PER_PROJECT: z.coerce.number().int().min(1).max(500).default(50),

  DOCUMENT_SAVE_DEBOUNCE_MS: z.coerce.number().int().min(100).max(30_000).default(1_500),
  DOCUMENT_SAVE_CEILING_MS: z.coerce.number().int().min(1_000).max(120_000).default(10_000),

  MAX_EVENT_WATCHERS_PER_PROJECT: z.coerce.number().int().min(1).max(200).default(25),

  TERMINAL_SCROLLBACK_BYTES: z.coerce
    .number()
    .int()
    .min(1024)
    .default(128 * 1024),

  TERMINAL_SESSION_IDLE_MS: z.coerce
    .number()
    .int()
    .min(10_000)
    .default(30 * 60_000),

  MAX_TERMINALS_PER_PROJECT: z.coerce.number().int().min(1).max(50).default(5),

  TERMINAL_HEARTBEAT_MS: z.coerce.number().int().min(1_000).default(30_000),

  RATE_LIMIT_RUNTIME_CONTROL_MAX: z.coerce.number().int().min(1).default(30),
  RATE_LIMIT_RUNTIME_CONTROL_WINDOW_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .default(10 * 60_000),

  SESSION_COOKIE_NAME: z.string().min(1).default('platform_session'),

  SESSION_ABSOLUTE_TTL_HOURS: z.coerce
    .number()
    .int()
    .min(1)
    .default(24 * 30),

  SESSION_IDLE_TTL_HOURS: z.coerce
    .number()
    .int()
    .min(1)
    .default(24 * 7),

  SESSION_LAST_SEEN_THROTTLE_SECONDS: z.coerce.number().int().min(0).default(60),

  SESSION_COOKIE_SECURE: booleanish.optional(),

  ASSET_MAX_BYTES: z.coerce
    .number()
    .int()
    .min(1024)
    .default(25 * 1024 * 1024),

  PROJECT_ASSET_MAX_BYTES: z.coerce
    .number()
    .int()
    .min(1024)
    .default(250 * 1024 * 1024),

  STORAGE_AVAILABILITY_TTL_MS: z.coerce.number().int().min(0).default(5_000),

  SECRETS_ENCRYPTION_KEY: optional(z.string().min(1)),
  SECRETS_PREVIOUS_KEYS: optional(z.string().min(1)),

  USER_DATABASE_ADMIN_URL: z.string().optional(),

  USER_DATABASE_CONTAINER_HOST: z.string().default('platform-userdb'),
  USER_DATABASE_CONTAINER_PORT: z.coerce.number().int().min(1).max(65_535).default(5432),

  GIT_HISTORY_LIMIT: z.coerce.number().int().min(1).max(500).default(50),

  GIT_MAX_REPOSITORY_BYTES: z.coerce
    .number()
    .int()
    .min(1024)
    .default(128 * 1024 * 1024),

  GIT_REMOTE_ALLOW_HTTP: z
    .string()
    .default('false')
    .transform((value) => value === 'true'),
  GIT_REMOTE_ALLOW_PRIVATE: z
    .string()
    .default('false')
    .transform((value) => value === 'true'),
  GIT_REMOTE_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(600_000).default(60_000),

  MAX_SNAPSHOTS_PER_PROJECT: z.coerce.number().int().min(1).max(200).default(25),

  MAX_AUTOMATIC_SNAPSHOTS_PER_PROJECT: z.coerce.number().int().min(1).max(20).default(3),

  SNAPSHOT_MAX_BYTES: z.coerce
    .number()
    .int()
    .min(1024)
    .default(64 * 1024 * 1024),

  MAX_VARIABLES_PER_PROJECT: z.coerce.number().int().min(1).max(500).default(100),

  MAX_SECRETS_PER_PROJECT: z.coerce.number().int().min(1).max(500).default(100),

  RUNTIME_WORKLOAD_UID: z.coerce.number().int().min(1).max(65_533).default(1_000),
  RUNTIME_WORKLOAD_GID: z.coerce.number().int().min(1).max(65_533).default(1_000),
  RUNTIME_WORKLOAD_HOME: z.string().min(1).default('/home/workload'),
  RUNTIME_RUN_AS_ROOT: booleanish.default(false),

  DATABASE_BACKUP_IMAGE: z.string().min(1).default('postgres:17-alpine'),
  DATABASE_BACKUP_TIMEOUT_MS: z.coerce.number().int().min(10_000).max(3_600_000).default(600_000),
  MAX_DATABASE_BACKUPS_PER_PROJECT: z.coerce.number().int().min(1).max(100).default(10),
  DATABASE_BACKUP_LIST_LIMIT: z.coerce.number().int().min(1).max(200).default(50),

  RUNTIME_PUBLISH_PORTS: z.enum(['auto', 'always', 'never']).default('auto'),

  RUNTIME_NETWORK_POOL: z
    .string()
    .regex(/^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/, 'A CIDR range such as 10.210.0.0/16')
    .default('10.210.0.0/16'),
  RUNTIME_NETWORK_PREFIX_LENGTH: z.coerce.number().int().min(20).max(29).default(28),

  DOMAIN_RECHECK_AFTER_MS: z.coerce
    .number()
    .int()
    .min(60_000)
    .default(6 * 60 * 60_000),
  DOMAIN_RECHECK_MISSES: z.coerce.number().int().min(1).max(20).default(3),
  DOMAIN_RECHECK_BATCH: z.coerce.number().int().min(1).max(1_000).default(50),

  TWO_FACTOR_ISSUER: z.string().min(1).max(40).default('Platform'),

  OPERATIONS_PAGE_SIZE: z.coerce.number().int().min(10).max(200).default(50),

  SMTP_HOST: z.string().min(1).optional(),
  SMTP_PORT: z.coerce.number().int().min(1).max(65_535).default(587),
  SMTP_SECURE: booleanish.default(false),
  SMTP_USER: z.string().min(1).optional(),
  SMTP_PASSWORD: z.string().min(1).optional(),
  MAIL_FROM: z.string().min(1).optional(),
  SMTP_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(10_000),
  MAIL_AVAILABILITY_TTL_MS: z.coerce.number().int().min(1_000).default(30_000),

  EMAIL_VERIFICATION_TTL_MINUTES: z.coerce.number().int().min(5).max(10_080).default(1_440),
  PASSWORD_RESET_TTL_MINUTES: z.coerce.number().int().min(5).max(1_440).default(30),
  MAIL_TOKENS_PER_WINDOW: z.coerce.number().int().min(1).max(50).default(5),
  MAIL_TOKEN_WINDOW_MINUTES: z.coerce.number().int().min(1).max(1_440).default(60),

  RECOVERY_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(600_000).default(30_000),

  ORPHAN_SWEEP_ENABLED: booleanish.default(true),
  ORPHAN_SWEEP_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(60_000)
    .max(24 * 60 * 60_000)
    .default(60 * 60_000),
  ORPHAN_GRACE_MINUTES: z.coerce.number().int().min(5).max(10_080).default(60),
  ORPHAN_SWEEP_DRY_RUN: booleanish.default(false),

  STORAGE_RETRY_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
  STORAGE_RETRY_BASE_MS: z.coerce.number().int().min(10).max(60_000).default(200),
  STORAGE_RETRY_MAX_MS: z.coerce.number().int().min(50).max(120_000).default(2_000),
  STORAGE_BREAKER_THRESHOLD: z.coerce.number().int().min(1).max(100).default(5),
  STORAGE_BREAKER_RESET_MS: z.coerce.number().int().min(1_000).max(600_000).default(30_000),

  STORAGE_ENDPOINT: optional(z.url()),
  STORAGE_BUCKET: optional(z.string().min(1)),
  STORAGE_ACCESS_KEY: optional(z.string().min(1)),
  STORAGE_SECRET_KEY: optional(z.string().min(1)),
});

export type Env = z.infer<typeof envSchema>;

const SENSITIVE_KEYS = new Set<string>([
  'DATABASE_URL',
  'REDIS_URL',
  'SESSION_SECRET',
  'SECRETS_ENCRYPTION_KEY',
  'SECRETS_PREVIOUS_KEYS',
  'STORAGE_ACCESS_KEY',
  'STORAGE_SECRET_KEY',
  'SMTP_PASSWORD',
  'USER_DATABASE_ADMIN_URL',
  'METRICS_TOKEN',
]);

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const present = Object.fromEntries(
    Object.entries(source).filter(([, value]) => value !== undefined && value !== ''),
  );
  const parsed = envSchema.safeParse(present);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => {
        const key = issue.path.join('.') || '(root)';
        return SENSITIVE_KEYS.has(key) ? `${key}: ${issue.code}` : `${key}: ${issue.message}`;
      })
      .join('\n  ');
    throw new Error(`Invalid environment configuration:\n  ${issues}`);
  }

  return parsed.data;
}

let cached: Env | undefined;

export function env(): Env {
  cached ??= loadEnv();
  return cached;
}

export function resetEnvCache(): void {
  cached = undefined;
}
