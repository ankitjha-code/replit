import { z } from 'zod';

/**
 * Centralised, validated configuration.
 *
 * Nothing else in the codebase reads `process.env`. The process refuses to
 * start on invalid configuration rather than failing later inside a request,
 * and secret-bearing values are never echoed back in the failure message.
 */

const portSchema = z.coerce.number().int().min(1).max(65535);

/** Treats an empty string as absent, so an unset .env line means "not configured". */
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

  /** Control-plane HTTP listener. */
  API_HOST: z.string().min(1).default('0.0.0.0'),
  API_PORT: portSchema.default(4000),

  /** Public origin the browser uses to reach the API. */
  API_PUBLIC_URL: z.url().default('http://localhost:4000'),

  /**
   * Public origin of the browser application.
   *
   * Separate from the API's, because the links the platform mails out are
   * opened by a person: they must land on a page, not on an endpoint. In
   * development these differ (Vite on 5173, the API on 4000); behind the proxy
   * they are the same origin, and saying so twice is cheaper than inferring it
   * wrongly on the one installation where they are not.
   */
  WEB_PUBLIC_URL: z.url().default('http://localhost:5173'),

  /** Comma-separated browser origins allowed to call the API with credentials. */
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

  /** Trust an upstream reverse proxy for client IP and protocol. */
  /**
   * The bearer token a metrics scraper must present at `/metrics`. Unset turns
   * the endpoint off entirely (it answers 404). The public proxy never routes
   * it; this is the second lock. At least 24 characters.
   */
  METRICS_TOKEN: z.string().min(24).optional(),

  TRUST_PROXY: booleanish.default(false),

  // ---------------------------------------------------------------------
  // Infrastructure. Each is optional: an unconfigured dependency is simply
  // not registered, so health reports what is actually wired up rather than
  // a permanently failing probe for something nobody is running.
  // ---------------------------------------------------------------------

  /** Platform database. Not the database a user's application receives. */
  DATABASE_URL: optional(z.string().startsWith('postgres')),

  /**
   * Connection pool ceiling. Sized against Postgres's own max_connections,
   * not against expected traffic: exceeding it fails every request rather
   * than queueing.
   */
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  DATABASE_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(100).default(5_000),
  DATABASE_IDLE_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(30_000),
  /** Postgres aborts a query that outlives this, freeing the connection. */
  DATABASE_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(100).default(15_000),

  /**
   * Where to reach Redis, if this installation has one.
   *
   * Optional, and not a store. Jobs are rows in the platform's own database,
   * which is what makes them durable and claimable exactly once; all Redis
   * carries is a nudge saying there is work, so a worker in another process
   * reacts immediately rather than on its next poll. An installation without it
   * works, a little more slowly.
   */
  REDIS_URL: optional(z.string().startsWith('redis')),

  // ---------------------------------------------------------------------
  // Abuse controls
  // ---------------------------------------------------------------------

  /**
   * Registration attempts allowed per client address per window. Low on
   * purpose: a person signs up once, so anything above a handful is either a
   * mistake or an attempt to enumerate which addresses have accounts.
   */
  RATE_LIMIT_REGISTER_MAX: z.coerce.number().int().min(1).default(5),
  RATE_LIMIT_REGISTER_WINDOW_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .default(15 * 60_000),

  /**
   * Sign-in attempts per client address per window. Higher than registration
   * because mistyping a password is normal, but still bounded: this is the
   * endpoint an attacker uses to guess credentials, and every attempt costs a
   * key derivation.
   */
  RATE_LIMIT_LOGIN_MAX: z.coerce.number().int().min(1).default(10),
  RATE_LIMIT_LOGIN_WINDOW_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .default(15 * 60_000),

  /**
   * Password-checked account operations per window.
   *
   * Changing a password and closing an account both sit behind a live session,
   * so the sign-in limiter never sees them. Without a ceiling here a stolen
   * session is an unlimited oracle for guessing the password that protects the
   * account it has already taken. Low, because nobody changes their password
   * five times in a quarter of an hour.
   */
  RATE_LIMIT_ACCOUNT_MAX: z.coerce.number().int().min(1).default(5),
  RATE_LIMIT_ACCOUNT_WINDOW_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .default(15 * 60_000),
  /** How long a wrong password waits before it is told so. */
  ACCOUNT_WRONG_PASSWORD_DELAY_MS: z.coerce.number().int().min(0).max(10_000).default(400),

  /**
   * Requests per window for anything that puts a message in an inbox.
   *
   * Tighter than sign-in's, because these cost more than a request: the person
   * receiving the consequence is not the person making it. Without a ceiling the
   * endpoint is a way to mail a stranger repeatedly using this platform's
   * reputation to do it.
   */
  RATE_LIMIT_MAIL_MAX: z.coerce.number().int().min(1).default(5),
  RATE_LIMIT_MAIL_WINDOW_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .default(15 * 60_000),

  /** Projects created per account per window. */
  RATE_LIMIT_PROJECT_CREATE_MAX: z.coerce.number().int().min(1).default(20),
  RATE_LIMIT_PROJECT_CREATE_WINDOW_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .default(60 * 60_000),

  /**
   * Projects one account may own. Every project becomes a container and a
   * filesystem once execution lands, so this is a real resource ceiling rather
   * than a product tier.
   */
  MAX_PROJECTS_PER_USER: z.coerce.number().int().min(1).default(50),

  // ---------------------------------------------------------------------
  // Project files
  //
  // Source files live in the platform database, so these are limits on that
  // table rather than on a disk. Large binaries belong in project asset
  // storage, which has its own lifecycle.
  // ---------------------------------------------------------------------

  /** Largest single file. */
  FILE_MAX_BYTES: z.coerce
    .number()
    .int()
    .min(1024)
    .default(1024 * 1024),

  /** Largest total across one project. */
  PROJECT_MAX_BYTES: z.coerce
    .number()
    .int()
    .min(1024)
    .default(64 * 1024 * 1024),

  /** Most files and folders one project may hold. */
  PROJECT_MAX_FILES: z.coerce.number().int().min(1).default(5_000),

  // ---------------------------------------------------------------------
  // Runtimes
  //
  // A runtime is a container backing one project's workspace. The control
  // plane records what should exist; an execution provider makes it so.
  // ---------------------------------------------------------------------

  /**
   * Which execution backend runs project code.
   *
   * `none` is the default and is honest rather than degraded: the platform
   * records runtimes and refuses to start them, saying why. A value is added
   * here only when a provider for it exists, so a configured backend can never
   * silently fall back to doing nothing.
   */
  EXECUTION_PROVIDER: z.enum(['none', 'docker']).default('none'),

  /**
   * Which backend builds and serves deployments.
   *
   * `execution` builds in the same container plane that runs development
   * runtimes, which is the only one this platform has: a build is a command run
   * against a project's files, and that is exactly what the execution provider
   * exists to do safely. It therefore needs EXECUTION_PROVIDER set to something
   * real as well.
   *
   * `none` is the default and is honest rather than degraded: the platform
   * records the deployment model and refuses to build, saying why. Opt in
   * rather than inferring it from the execution provider, because deploying
   * means serving somebody's code to the public and an installation should have
   * to say it wants that.
   */
  DEPLOYMENT_PROVIDER: z.enum(['none', 'execution']).default('none'),

  /**
   * Deployments one project may keep.
   *
   * Each holds a snapshot of the project's source, so the history is not free.
   * The oldest stopped ones are pruned; nothing that is serving is ever pruned.
   */
  MAX_DEPLOYMENTS_PER_PROJECT: z.coerce.number().int().min(1).max(200).default(20),

  /**
   * Ceilings on what a build may hand back.
   *
   * A build runs a command somebody wrote, so what it produces is unbounded
   * until something bounds it. Reaching one of these is a refusal rather than a
   * truncation: half a site served as a whole one is worse than a build that
   * says it produced too much.
   */
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

  /**
   * How long a build may run before it is abandoned.
   *
   * A build that never ends holds a container, a row in BUILDING and somebody's
   * attention. Generous, because installing dependencies genuinely is slow.
   */
  DEPLOYMENT_BUILD_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(10_000)
    .default(15 * 60 * 1000),

  /** How much of a build's output is kept to show afterwards. */
  DEPLOYMENT_MAX_LOG_BYTES: z.coerce
    .number()
    .int()
    .min(1024)
    .default(256 * 1024),

  /**
   * What a deployment is allowed of the machine.
   *
   * Separate from the development runtime's ceilings, and deliberately: a
   * runtime exists while somebody watches it, and a deployment runs unattended
   * for as long as it is up. An installation may reasonably want to be more
   * generous with one and stricter with the other.
   */
  DEPLOYMENT_CPU_MILLICORES: z.coerce.number().int().min(100).max(64_000).default(1_000),
  DEPLOYMENT_MEMORY_MB: z.coerce.number().int().min(64).max(65_536).default(512),
  DEPLOYMENT_PIDS_LIMIT: z.coerce.number().int().min(16).max(10_000).default(256),

  /**
   * How long to wait for a started deployment to answer on a port.
   *
   * Nothing is reported running until something responds, so this is the
   * budget for a server to get up. A server that takes longer is reported as
   * failed, which is truer than a green status in front of a blank page.
   */
  DEPLOYMENT_READY_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(60_000),

  /** How long a probe waits for one answer while looking for the port. */
  DEPLOYMENT_PROBE_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(1_000),

  /**
   * Lines of output one project keeps.
   *
   * A number of lines rather than a length of time: the platform promises the
   * last N lines, which is a promise it can keep, and a project that printed
   * nothing for a month would otherwise have its log emptied for being quiet.
   */
  PROJECT_LOG_RETAINED_LINES: z.coerce.number().int().min(100).max(1_000_000).default(20_000),

  /**
   * How long a line may wait in memory before it is written, and how many may
   * wait before a write happens regardless.
   *
   * Batched because a program printing a thousand lines a second is ordinary
   * and a round trip each would make keeping a log the most expensive thing
   * about running anything.
   */
  PROJECT_LOG_FLUSH_MS: z.coerce.number().int().min(50).max(60_000).default(1_000),
  PROJECT_LOG_FLUSH_LINES: z.coerce.number().int().min(1).max(10_000).default(200),

  /** Namespaced, so a Redis shared with something else stays safe. */
  REDIS_JOB_CHANNEL: z.string().min(1).default('platform:jobs'),

  /**
   * Whether this process does the work as well as accepting it.
   *
   * True by default, which is the single-process arrangement everything else
   * here assumes. Set false when running workers as their own processes, so the
   * control plane accepts work and does none of it.
   */
  JOB_WORKER_ENABLED: z
    .string()
    .default('true')
    .transform((value) => value !== 'false'),

  /**
   * How often a worker looks for work regardless of nudges.
   *
   * The reason losing the queue is a latency problem rather than a correctness
   * one: a worker that missed every nudge still finds the same work by looking.
   */
  /** Jobs one worker process runs at once. */
  JOB_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
  JOB_POLL_INTERVAL_MS: z.coerce.number().int().min(200).max(60_000).default(2_000),

  /** How many times a job is tried, and how long it waits between attempts. */
  JOB_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(3),
  JOB_RETRY_BASE_MS: z.coerce.number().int().min(100).max(600_000).default(5_000),
  JOB_RETRY_MAX_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(120_000),

  /**
   * How long a worker waits for one job before giving up on it.
   *
   * Generous, because the jobs are an image pull and a dependency install. What
   * ends at this point is the worker's willingness to wait, not the work: a
   * timed-out build may still be running in a container somewhere.
   */
  JOB_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(10_000)
    .default(20 * 60 * 1000),

  /**
   * How often a running job is touched, and how long it may go untouched before
   * it is assumed abandoned.
   *
   * The heartbeat is comfortably shorter than the staleness threshold, because
   * one missed beat — a slow query, a moment of load — must not be enough to
   * take work away from a worker that is still doing it. The threshold is the
   * number that decides how quickly a killed worker's work comes back.
   */
  JOB_HEARTBEAT_MS: z.coerce.number().int().min(500).max(120_000).default(10_000),
  JOB_STALE_AFTER_MS: z.coerce.number().int().min(5_000).max(3_600_000).default(60_000),

  /** How often to look for work whose worker stopped saying it was there. */
  JOB_REAP_INTERVAL_MS: z.coerce.number().int().min(1_000).max(600_000).default(30_000),

  /** How many of a project's jobs a listing returns. */
  /**
   * How many of each kind of job may run at once across every worker. Zero is
   * no limit. Builds are the one worth limiting: each is a container installing
   * dependencies, and a burst of deploys would otherwise take every execution
   * host at once while environments wait.
   */
  JOB_CONCURRENCY_RUNTIME_START: z.coerce.number().int().min(0).max(1_000).default(0),
  JOB_CONCURRENCY_DEPLOYMENT_BUILD: z.coerce.number().int().min(0).max(1_000).default(0),
  /**
   * Alerting on deployments. Checked by the worker process only, like the
   * domain re-check: how often each opted-in project is looked at, how many one
   * pass looks at, and how many past alerts a project's page lists.
   */
  ALERT_CHECK_INTERVAL_MS: z.coerce.number().int().min(10_000).max(3_600_000).default(60_000),
  ALERT_BATCH: z.coerce.number().int().min(1).max(1_000).default(50),
  ALERT_EVENTS_SHOWN: z.coerce.number().int().min(1).max(200).default(20),
  JOB_LIST_LIMIT: z.coerce.number().int().min(1).max(200).default(20),

  /**
   * How often a workload's resource use is measured, and how much trend is kept.
   *
   * A reading is taken when somebody asks for one, throttled by this interval so
   * two people watching one project cost the same as one. The window is held in
   * memory: it starts when the control plane starts and is gone when the process
   * is, which the page says rather than implying a history it does not have.
   */
  MONITORING_SAMPLE_INTERVAL_MS: z.coerce.number().int().min(1_000).max(300_000).default(5_000),
  MONITORING_HISTORY_SAMPLES: z.coerce.number().int().min(2).max(2_000).default(60),

  /**
   * What a project's health check asks for, until the project says otherwise.
   *
   * "/" is the wrong answer for plenty of applications — an API serving no page
   * at its root would be reported unhealthy for doing exactly what it was
   * written to do — so it is a default rather than a rule.
   */
  HEALTH_CHECK_DEFAULT_PATH: z.string().min(1).max(200).default('/'),
  HEALTH_CHECK_DEFAULT_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(3_000),

  /** Custom domains one project may hold. */
  MAX_DOMAINS_PER_PROJECT: z.coerce.number().int().min(1).max(50).default(5),

  /**
   * How long a DNS lookup may take while verifying a domain, and which
   * resolvers to ask.
   *
   * Bounded because a name whose servers do not answer would otherwise hold the
   * request somebody is waiting on. The resolvers are configurable because a
   * platform serving custom domains is often behind one that answers for
   * internal names, and verification needs the answer the public internet gets.
   */
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

  /** Where the public listener binds, and the hostname suffix it answers on. */
  DEPLOYMENT_PORT: z.coerce.number().int().min(1).max(65_535).default(4200),
  DEPLOYMENT_HOST_SUFFIX: z.string().default('localhost:4200'),
  DEPLOYMENT_SCHEME: z.enum(['http', 'https']).default('http'),

  /**
   * How much static output is held in memory across all deployments.
   *
   * A static site is served from the archive the platform stored, unpacked on
   * first use and kept. Bounded so a host with many sites does not hold every
   * one of them for ever; the least recently used is dropped and re-read.
   */
  DEPLOYMENT_STATIC_CACHE_BYTES: z.coerce
    .number()
    .int()
    .min(1024)
    .default(256 * 1024 * 1024),

  /**
   * Sockets one account may hold at once, across every gateway.
   *
   * The per-project ceilings each gateway has cannot answer this: a person with
   * twenty projects is under every one of them while holding eighty
   * connections, and a person who creates projects in a loop is under them for
   * ever.
   */
  MAX_SOCKETS_PER_USER: z.coerce.number().int().min(1).max(1_000).default(40),

  /**
   * Upgrade attempts one client may make in a window, refused or not.
   *
   * Checked before a session is resolved, which is the only place worth
   * checking: what it bounds is the two database queries an attempt costs, and
   * checking afterwards would mean paying them in order to decide not to.
   *
   * Generous, because a shared address shares this budget and because the thing
   * it stops is a runaway reconnect loop rather than a determined attacker.
   */
  MAX_SOCKET_ATTEMPTS: z.coerce.number().int().min(1).max(10_000).default(120),
  SOCKET_ATTEMPT_WINDOW_MS: z.coerce.number().int().min(1_000).default(60_000),

  /**
   * How much a single socket may send, as a burst and then a rate.
   *
   * A token bucket rather than a fixed window, because the traffic is bursty by
   * nature: a paste into a terminal is a hundred messages in a moment and is
   * entirely legitimate, while a hundred a second sustained is not.
   */
  SOCKET_MESSAGE_BURST: z.coerce.number().int().min(1).max(100_000).default(200),
  SOCKET_MESSAGES_PER_SECOND: z.coerce.number().int().min(1).max(10_000).default(50),

  /**
   * A ceiling on request rate for the whole API.
   *
   * Deliberately loose. The specific limits on registration, sign-in and
   * project creation protect the endpoints an attacker hits hardest; this one
   * is not shaping traffic, only stopping one client from making the platform
   * unusable for everybody else while somebody notices.
   */
  RATE_LIMIT_GLOBAL_MAX: z.coerce.number().int().min(1).default(600),
  RATE_LIMIT_GLOBAL_WINDOW_MS: z.coerce.number().int().min(1_000).default(60_000),

  /**
   * How long an ordinary request may take before it is given up on.
   *
   * The server's own request timeout is disabled, because this process holds
   * WebSocket upgrades and streams output and a connection-level timeout would
   * cut a terminal off mid-session. This is the ceiling that replaces it, and
   * it applies only until a response starts: an archive download takes as long
   * as the archive is big.
   */
  REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(600_000).default(30_000),

  /**
   * How much of the platform one account may be using at once.
   *
   * Different in kind from every other limit here, which bound the size of one
   * thing. These bound how many things at once, which is the only kind of limit
   * that stops one account filling a machine everybody shares. The scheduler's
   * host capacity is not a substitute: it stops the platform overcommitting and
   * says nothing about who filled it.
   *
   * Charged to the project's owner, because that is the account its storage,
   * database and deployments are already charged to — and because charging the
   * person who pressed the button would let somebody raise their own ceiling by
   * being added to other people's projects.
   */
  MAX_CONCURRENT_RUNTIMES_PER_USER: z.coerce.number().int().min(1).max(1_000).default(3),
  MAX_CONCURRENT_DEPLOYMENTS_PER_USER: z.coerce.number().int().min(1).max(1_000).default(5),

  /**
   * Builds in flight, limited more tightly than deployments.
   *
   * They are not the same cost: a running deployment is a container sitting
   * there, and a build is a machine installing dependencies flat out. Somebody
   * with five deployments uses five containers; somebody redeploying five
   * projects at once uses the whole host.
   */
  MAX_CONCURRENT_BUILDS_PER_USER: z.coerce.number().int().min(1).max(100).default(2),

  /**
   * The machines that may run workloads, as JSON.
   *
   * Unset means one host, using DOCKER_SOCKET_PATH below, which is what a
   * single-machine installation has always had. Set it to spread work across
   * several:
   *
   *   [{"name":"a","cpuMillicores":4000,"memoryMb":8192},
   *    {"name":"b","url":"tcp://10.0.0.5:2375","cpuMillicores":8000,"memoryMb":16384}]
   *
   * Capacity is declared rather than measured: a machine's own total includes
   * whatever else runs there, and a platform scheduling against it would fill a
   * host that was already busy. What is written here is a budget the platform
   * stays inside.
   *
   * A malformed list refuses to start. An installation that meant to run several
   * hosts and silently ran one would be worse than one that will not come up.
   */
  EXECUTION_HOSTS: optional(z.string().min(1)),

  /**
   * How many workloads one host may carry, when no host list is declared.
   *
   * Also what the implicit single host's processor and memory budgets are
   * derived from, which makes it a guess about a machine nobody described. An
   * installation that cares sets EXECUTION_HOSTS and stops guessing; this is
   * what keeps a platform that has not thought about it from placing without any
   * ceiling at all.
   */
  MAX_WORKLOADS_PER_HOST: z.coerce.number().int().min(1).max(1_000).default(20),

  /**
   * Kernel ceilings on a workload, beside the container runtime's own.
   *
   * A descriptor leak exhausts a host long before it exhausts a memory limit,
   * and it does it to every other container on the machine rather than only to
   * itself. Generous enough for a real build, bounded because nothing legitimate
   * needs an unbounded number.
   */
  RUNTIME_MAX_OPEN_FILES: z.coerce.number().int().min(256).max(1_048_576).default(8_192),

  /**
   * How much writable temporary space a workload gets, in megabytes.
   *
   * A tmpfs rather than the image's own `/tmp`, so what is written there is
   * bounded, is not on the host's disk, and goes when the container does.
   */
  /**
   * Disk each development environment and each deployment may write, in MB.
   * Measured by the worker every DISK_CHECK_INTERVAL_MS; a workload over its
   * limit is stopped and its owner told why.
   */
  RUNTIME_DISK_MB: z.coerce.number().int().min(64).max(1_000_000).default(2_048),
  DEPLOYMENT_DISK_MB: z.coerce.number().int().min(64).max(1_000_000).default(2_048),
  DISK_CHECK_INTERVAL_MS: z.coerce.number().int().min(5_000).max(3_600_000).default(60_000),
  /**
   * `monitor` (default): measure and stop, which works everywhere but only
   * notices at the next check. `enforce`: also have the container runtime
   * refuse writes past the limit — requires overlay2 on XFS with project quotas
   * (or btrfs/zfs); Docker's containerd snapshotter silently ignores it.
   */
  DISK_LIMIT_MODE: z.enum(['monitor', 'enforce']).default('monitor'),
  /**
   * The OCI runtime users' code runs under. Empty for the daemon's default
   * (runc). `runsc` runs every workload under gVisor, which must be installed
   * on each execution host and registered with its Docker daemon.
   */
  RUNTIME_OCI_RUNTIME: z
    .string()
    .regex(/^[a-z0-9_-]{1,32}$/)
    .optional(),
  RUNTIME_TMP_MB: z.coerce.number().int().min(16).max(16_384).default(256),

  /**
   * Where the Docker daemon listens.
   *
   * Left unset for a normal local install, where the platform's own default
   * socket is right. This is the control plane's connection to the daemon, and
   * it is never passed to a workload: a container that can reach this socket
   * can create a privileged container and take the host.
   */
  DOCKER_SOCKET_PATH: optional(z.string().min(1)),

  /**
   * The Docker network runtimes are attached to.
   *
   * Their own, away from the platform's. A workload sharing a network with the
   * control plane could reach the database directly.
   */
  RUNTIME_NETWORK: z.string().min(1).default('platform-runtimes'),

  /** Where a project's files live inside its container. */
  RUNTIME_WORKSPACE_PATH: z.string().startsWith('/').default('/workspace'),

  /**
   * How long an image pull may take. Bounded so a slow registry holds a
   * request open for a knowable time rather than indefinitely.
   */
  RUNTIME_IMAGE_PULL_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .default(5 * 60_000),

  /**
   * How long a "can the daemon be reached" answer is reused. Every workspace
   * page asks, and a ping per page view buys nothing: a daemon that died a
   * second ago is reported on the next request either way.
   */
  RUNTIME_AVAILABILITY_TTL_MS: z.coerce.number().int().min(0).default(5_000),

  /**
   * Resource ceiling applied to every runtime.
   *
   * A development environment with no ceiling lets one project take the
   * machine away from every other project on it. The process limit is separate
   * because neither a CPU share nor a memory cap stops a fork bomb.
   */
  RUNTIME_CPU_MILLICORES: z.coerce.number().int().min(100).max(8_000).default(1_000),
  RUNTIME_MEMORY_MB: z.coerce.number().int().min(128).max(16_384).default(1_024),
  RUNTIME_PIDS_LIMIT: z.coerce.number().int().min(16).max(4_096).default(256),

  /**
   * How long a runtime is given to shut down before it is killed. Long enough
   * for a server to close its connections, short enough that nobody waits.
   */
  RUNTIME_STOP_GRACE_SECONDS: z.coerce.number().int().min(1).max(120).default(10),

  // ---------------------------------------------------------------------
  // Previews
  //
  // A project's own application, served to a browser. On its own listener and
  // its own hostname per project: whatever a project serves is code the
  // platform did not write, and on the platform's origin it could act as the
  // person looking at it.
  // ---------------------------------------------------------------------

  /** The preview listener. Separate from the API's, and from the web app's. */
  PREVIEW_PORT: portSchema.default(4100),

  /**
   * The hostname suffix a preview is served under, including the port.
   *
   * A project's preview is at `<project id>.<suffix>`. `localhost` is used
   * because browsers resolve every name under it to loopback without any DNS,
   * so a local install needs no configuration to get one origin per project.
   */
  PREVIEW_HOST_SUFFIX: z.string().min(1).default('localhost:4100'),

  /** How a preview address is built. `https` once there is a certificate. */
  PREVIEW_SCHEME: z.enum(['http', 'https']).default('http'),

  PREVIEW_COOKIE_NAME: z.string().min(1).default('platform_preview'),

  /**
   * How long a preview link may be exchanged for a cookie.
   *
   * Short on purpose. It is redeemed within a second of being issued, and it
   * travels in an address, which is the least private place a secret can be.
   */
  PREVIEW_GRANT_TTL_SECONDS: z.coerce.number().int().min(5).max(600).default(60),

  /** How long a browser may keep viewing before it asks again. */
  PREVIEW_SESSION_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(60)
    .default(8 * 60 * 60),

  /** How long to wait for a port to accept a connection while looking for one. */
  PREVIEW_PROBE_TIMEOUT_MS: z.coerce.number().int().min(50).max(10_000).default(1_000),

  /**
   * How much of the application's output is kept for a client that connects
   * after it started.
   *
   * In memory and bounded. This is a window onto a running program rather than
   * a log, and the platform says when it has dropped older lines rather than
   * presenting a partial log as a whole one.
   */
  RUN_OUTPUT_BUFFER_BYTES: z.coerce
    .number()
    .int()
    .min(1024)
    .default(256 * 1024),
  RUN_OUTPUT_BUFFER_LINES: z.coerce.number().int().min(10).default(2_000),

  /** Watchers of one project's output at once. */
  MAX_OUTPUT_WATCHERS_PER_PROJECT: z.coerce.number().int().min(1).max(100).default(10),

  /**
   * Files one project may have open for collaborative editing at once.
   *
   * Each holds a whole file in memory for as long as somebody has it open, so
   * this bounds what a project can make the control plane hold.
   */
  MAX_OPEN_DOCUMENTS_PER_PROJECT: z.coerce.number().int().min(1).max(200).default(20),

  /**
   * Editors one project may have attached at once, across everybody in it.
   *
   * Separate from the document limit above: one file open in ten windows is one
   * document and ten editors, and the two cost different things.
   */
  MAX_DOCUMENT_EDITORS_PER_PROJECT: z.coerce.number().int().min(1).max(500).default(50),

  /**
   * How long after the last keystroke a shared document is written back, and
   * how long typing may continue before it is written back regardless.
   *
   * The second is not redundant. Without it, somebody typing without pause has
   * nothing written down for as long as they keep typing, and a shared document
   * lives only in memory until it is.
   */
  DOCUMENT_SAVE_DEBOUNCE_MS: z.coerce.number().int().min(100).max(30_000).default(1_500),
  DOCUMENT_SAVE_CEILING_MS: z.coerce.number().int().min(1_000).max(120_000).default(10_000),

  /**
   * Event-and-presence connections one project may have at once.
   *
   * Counted across everybody in the project rather than per person, because what
   * it bounds is the broadcast: the roster goes to everyone whenever anyone
   * arrives, leaves or changes file, so the cost of a room grows with the square
   * of the windows open on it.
   */
  MAX_EVENT_WATCHERS_PER_PROJECT: z.coerce.number().int().min(1).max(200).default(25),

  /**
   * How much of what a shell printed is kept so a screen can be rebuilt.
   *
   * A terminal that survives a reload is only useful if what was on it does
   * too. Bounded per session, because this is held in memory and a runaway
   * process printing forever must not be able to grow it without limit.
   */
  TERMINAL_SCROLLBACK_BYTES: z.coerce
    .number()
    .int()
    .min(1024)
    .default(128 * 1024),

  /**
   * How long a terminal nobody is attached to is kept before it is closed.
   *
   * Long enough to cover a reload, a tab restored after lunch, or a laptop
   * that was shut. Not indefinite: a shell nobody will ever attach to again is
   * a process nobody will ever stop.
   */
  TERMINAL_SESSION_IDLE_MS: z.coerce
    .number()
    .int()
    .min(10_000)
    .default(30 * 60_000),

  /**
   * Terminals one project may have open at once.
   *
   * Each is a shell inside the container and a socket held open here. A bound
   * exists so one project cannot open them until the host runs out of
   * processes, which its own process limit would otherwise absorb silently.
   */
  MAX_TERMINALS_PER_PROJECT: z.coerce.number().int().min(1).max(50).default(5),

  /**
   * How often a silent terminal socket is checked for still being there.
   *
   * A tab closed by a laptop lid leaves a socket that looks open from here,
   * and each one holds a shell in a container.
   */
  TERMINAL_HEARTBEAT_MS: z.coerce.number().int().min(1_000).default(30_000),

  /**
   * Runtime start and stop requests per account per window. Starting a
   * container is one of the most expensive things a request can ask for, and
   * repeatedly starting and stopping is how one account degrades the host for
   * everyone.
   */
  RATE_LIMIT_RUNTIME_CONTROL_MAX: z.coerce.number().int().min(1).default(30),
  RATE_LIMIT_RUNTIME_CONTROL_WINDOW_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .default(10 * 60_000),

  // ---------------------------------------------------------------------
  // Sessions
  // ---------------------------------------------------------------------

  SESSION_COOKIE_NAME: z.string().min(1).default('platform_session'),

  /**
   * Hard lifetime. A session stops working at this point no matter how active
   * it has been, so a stolen cookie cannot be useful indefinitely.
   */
  SESSION_ABSOLUTE_TTL_HOURS: z.coerce
    .number()
    .int()
    .min(1)
    .default(24 * 30),

  /**
   * Idle lifetime. An unused session expires sooner than the absolute limit,
   * which is what closes an abandoned browser on a shared machine.
   */
  SESSION_IDLE_TTL_HOURS: z.coerce
    .number()
    .int()
    .min(1)
    .default(24 * 7),

  /**
   * Minimum gap between last-seen writes. Without it every authenticated
   * request becomes a database write, which is a lot of load to buy a
   * timestamp accurate to the second.
   */
  SESSION_LAST_SEEN_THROTTLE_SECONDS: z.coerce.number().int().min(0).default(60),

  /**
   * Marks the session cookie Secure. Defaults on outside development, where
   * sending a session over plain HTTP would be a mistake. Overridable because
   * a local HTTPS setup may want it on, but a production deployment that turns
   * it off is doing something it should have to spell out.
   */
  SESSION_COOKIE_SECURE: booleanish.optional(),

  /**
   * Largest single asset. Assets are held in memory while being hashed and
   * stored, so this is a real memory ceiling and not only a product limit.
   */
  ASSET_MAX_BYTES: z.coerce
    .number()
    .int()
    .min(1024)
    .default(25 * 1024 * 1024),

  /** Largest total of assets across one project. */
  PROJECT_ASSET_MAX_BYTES: z.coerce
    .number()
    .int()
    .min(1024)
    .default(250 * 1024 * 1024),

  /** How long a "can the file store be reached" answer is reused. */
  STORAGE_AVAILABILITY_TTL_MS: z.coerce.number().int().min(0).default(5_000),

  /**
   * The key project secrets are encrypted with: 32 bytes, base64.
   *
   * Absent means the platform cannot store secrets and says so. It is never
   * generated per process: a value encrypted with a key that dies with the
   * process is a value no later process can read.
   *
   * Generate one with `openssl rand -base64 32`. Losing it loses every secret
   * stored under it, which is the intended property.
   */
  SECRETS_ENCRYPTION_KEY: optional(z.string().min(1)),
  /**
   * Keys that used to be current, comma-separated, for reading only.
   *
   * Set during a rotation: the new key goes in SECRETS_ENCRYPTION_KEY, the old
   * one here, and `pnpm --filter @platform/api secrets:rotate` re-seals every
   * stored value with the new one. After that it can be removed. Never used to
   * seal anything.
   */
  SECRETS_PREVIOUS_KEYS: optional(z.string().min(1)),

  /** Most secrets one project may hold. Every one is injected at every start. */
  /**
   * Where the platform provisions databases for projects.
   *
   * A separate server from the platform's own, reached as an administrator so
   * roles and databases can be created. Absent means the platform cannot give
   * a project a database and says so, rather than pretending to have made one.
   *
   * This URL is the control plane's own way in, over loopback. It is never what
   * an application is given: a container cannot reach the platform's loopback,
   * and would not be handed administrator credentials if it could.
   */
  USER_DATABASE_ADMIN_URL: z.string().optional(),

  /**
   * How an application reaches that server from inside its container.
   *
   * A container name on the runtime network, not an address on the host. The
   * two are different doors into the same server and neither can be used from
   * where the other is used.
   */
  USER_DATABASE_CONTAINER_HOST: z.string().default('platform-userdb'),
  USER_DATABASE_CONTAINER_PORT: z.coerce.number().int().min(1).max(65_535).default(5432),

  /** How much history one listing returns. */
  GIT_HISTORY_LIMIT: z.coerce.number().int().min(1).max(500).default(50),

  /**
   * The largest packed repository this installation will store.
   *
   * Every commit rewrites the whole archive, so this bounds the cost of a
   * commit as well as the cost of keeping one.
   */
  GIT_MAX_REPOSITORY_BYTES: z.coerce
    .number()
    .int()
    .min(1024)
    .default(128 * 1024 * 1024),

  /**
   * Git remotes. The control plane makes these requests, to addresses users
   * type, so both relaxations are off: plain http, and private or loopback
   * addresses (turn on for a self-hosted forge on the same network, knowing that
   * it also lets any project owner reach that network from here).
   */
  GIT_REMOTE_ALLOW_HTTP: z
    .string()
    .default('false')
    .transform((value) => value === 'true'),
  GIT_REMOTE_ALLOW_PRIVATE: z
    .string()
    .default('false')
    .transform((value) => value === 'true'),
  GIT_REMOTE_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(600_000).default(60_000),

  /**
   * Snapshots one project may keep.
   *
   * Bounded because each one is a whole copy of the project's source, and a
   * feature whose cost grows without limit is one an installation cannot plan
   * for.
   */
  MAX_SNAPSHOTS_PER_PROJECT: z.coerce.number().int().min(1).max(200).default(25),

  /**
   * Snapshots the platform keeps on a project's behalf, before each restore.
   *
   * Separate from the allowance above and deliberately small. These exist so the
   * last restore can be undone; an undo of an undo of an undo is not something
   * anybody has asked for, and they are pruned oldest-first. Counting them
   * against what a person may keep would mean refusing to let somebody go back
   * because they had used up their snapshots, which is the worst possible moment
   * to enforce a quota.
   */
  MAX_AUTOMATIC_SNAPSHOTS_PER_PROJECT: z.coerce.number().int().min(1).max(20).default(3),

  /** The largest archive a single snapshot may produce. */
  SNAPSHOT_MAX_BYTES: z.coerce
    .number()
    .int()
    .min(1024)
    .default(64 * 1024 * 1024),

  /**
   * Plain environment variables one project may hold.
   *
   * Bounded for the same reason secrets are: every one is injected into every
   * container start, so the ceiling is on what a start has to carry.
   */
  MAX_VARIABLES_PER_PROJECT: z.coerce.number().int().min(1).max(500).default(100),

  MAX_SECRETS_PER_PROJECT: z.coerce.number().int().min(1).max(500).default(100),

  /**
   * Who a workload runs as.
   *
   * The largest thing every other hardening measure does not fix: capabilities
   * can all be dropped and the process inside is still uid 0, so every file the
   * image ships is writable by it and any future container-runtime escape starts
   * from root rather than from nobody.
   *
   * Numeric rather than a name, because a name has to exist in the image's own
   * passwd file and does not exist in all of them — `node` images have a `node`
   * user at 1000, the official Python images have none. The kernel does not need
   * the name; the only cost is a shell prompt that says `I have no name!`.
   */
  RUNTIME_WORKLOAD_UID: z.coerce.number().int().min(1).max(65_533).default(1_000),
  RUNTIME_WORKLOAD_GID: z.coerce.number().int().min(1).max(65_533).default(1_000),
  /**
   * A writable home for the workload, outside its project files.
   *
   * Package managers and language runtimes all write caches into `$HOME`, and a
   * non-root workload without a writable one cannot install a dependency —
   * which is the failure that makes somebody turn the whole measure off. Not
   * the workspace, which would put caches in the file explorer and in every
   * snapshot; not `/tmp`, which is a bounded tmpfs and therefore memory.
   */
  RUNTIME_WORKLOAD_HOME: z.string().min(1).default('/home/workload'),
  /**
   * The escape hatch, for an image that genuinely cannot run unprivileged.
   *
   * Configuration rather than a code path, so that choosing it is visible in one
   * place and an installation can be asked whether it is set.
   */
  RUNTIME_RUN_AS_ROOT: booleanish.default(false),

  /**
   * Where `pg_dump` and `pg_restore` come from.
   *
   * A container image, because the platform may not run a command on its host —
   * and that rule has no exception for tools the platform trusts. The moment
   * there is one, the boundary is a matter of judgement rather than a property.
   *
   * Its major version should be at least the project database server's:
   * `pg_dump` refuses to dump a server newer than itself.
   */
  DATABASE_BACKUP_IMAGE: z.string().min(1).default('postgres:17-alpine'),
  DATABASE_BACKUP_TIMEOUT_MS: z.coerce.number().int().min(10_000).max(3_600_000).default(600_000),
  MAX_DATABASE_BACKUPS_PER_PROJECT: z.coerce.number().int().min(1).max(100).default(10),
  DATABASE_BACKUP_LIST_LIMIT: z.coerce.number().int().min(1).max(200).default(50),

  /**
   * Whether preview ports are published on the host.
   *
   * A published port is reachable from containers on other Docker networks —
   * verified against a real daemon — so publishing preview ports lets any
   * project connect to any other project's running application. `auto` publishes
   * only on Docker Desktop, where the host cannot reach a container any other
   * way; on Linux the platform dials the container directly and publishes
   * nothing. Only set `always` knowingly, on a single-developer machine.
   */
  RUNTIME_PUBLISH_PORTS: z.enum(['auto', 'always', 'never']).default('auto'),

  /**
   * Where project networks get their addresses.
   *
   * Every project has its own network, and left to itself Docker gives each one
   * a large subnet from a pool that runs out at about thirty — after which no
   * project can start. The platform carves small subnets from this range
   * instead: a `/16` in `/28`s is 4,096 project networks with room for a dozen
   * containers each. Choose a range nothing else on the host uses.
   */
  RUNTIME_NETWORK_POOL: z
    .string()
    .regex(/^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/, 'A CIDR range such as 10.210.0.0/16')
    .default('10.210.0.0/16'),
  RUNTIME_NETWORK_PREFIX_LENGTH: z.coerce.number().int().min(20).max(29).default(28),

  /**
   * Re-checking verified custom domains.
   *
   * Verification proves control at one moment; a domain can be sold or
   * repointed afterwards. The worker re-checks each verified domain at most
   * this often, and retires one only after this many misses in a row — so a
   * domain is retired after roughly misses × interval of pointing elsewhere,
   * never after one bad lookup.
   */
  DOMAIN_RECHECK_AFTER_MS: z.coerce
    .number()
    .int()
    .min(60_000)
    .default(6 * 60 * 60_000),
  DOMAIN_RECHECK_MISSES: z.coerce.number().int().min(1).max(20).default(3),
  DOMAIN_RECHECK_BATCH: z.coerce.number().int().min(1).max(1_000).default(50),

  /** How the platform is named in somebody's authenticator app. */
  TWO_FACTOR_ISSUER: z.string().min(1).max(40).default('Platform'),

  /** Accounts per page on the operations list. */
  OPERATIONS_PAGE_SIZE: z.coerce.number().int().min(10).max(200).default(50),

  /**
   * Where the platform sends mail through.
   *
   * SMTP rather than a mail API, because every hosted service has its own SDK,
   * credentials and account, and picking one would make a paid third party part
   * of being able to run this. Every mail service and every self-hosted mail
   * server speaks SMTP, so an installation can point at a container on the same
   * machine or at a company relay without the platform knowing the difference.
   *
   * With no host and no from-address, the platform gets a mail provider that
   * refuses and says why. Address verification and password reset are then
   * offered as unavailable rather than failing when somebody tries them.
   */
  SMTP_HOST: z.string().min(1).optional(),
  SMTP_PORT: z.coerce.number().int().min(1).max(65_535).default(587),
  /**
   * TLS from the first byte, conventionally port 465.
   *
   * False does not mean plaintext: the client still upgrades with STARTTLS when
   * the server offers it, which is what a submission port on 587 does.
   */
  SMTP_SECURE: booleanish.default(false),
  /** Optional: a local mail container wants no credentials at all. */
  SMTP_USER: z.string().min(1).optional(),
  SMTP_PASSWORD: z.string().min(1).optional(),
  /** What messages say they are from. Usually has to match the account. */
  MAIL_FROM: z.string().min(1).optional(),
  SMTP_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(10_000),
  MAIL_AVAILABILITY_TTL_MS: z.coerce.number().int().min(1_000).default(30_000),

  /**
   * How long the links the platform mails out stay usable.
   *
   * A verification link proves an address and grants nothing, so it can last a
   * day. A reset link **is** the password for as long as it lives, and the
   * window in which a forwarded or logged URL is dangerous should be minutes.
   */
  EMAIL_VERIFICATION_TTL_MINUTES: z.coerce.number().int().min(5).max(10_080).default(1_440),
  PASSWORD_RESET_TTL_MINUTES: z.coerce.number().int().min(5).max(1_440).default(30),
  /**
   * How many links of one kind one account may be sent per window.
   *
   * Beside the per-address route limiter, and stopping something different:
   * that one stops a client hammering the endpoint, this stops many clients
   * doing it to one person — which is what turns a reset endpoint into a way to
   * fill somebody's inbox.
   */
  MAIL_TOKENS_PER_WINDOW: z.coerce.number().int().min(1).max(50).default(5),
  MAIL_TOKEN_WINDOW_MINUTES: z.coerce.number().int().min(1).max(1_440).default(60),

  /**
   * How long the boot-time reconciliation may take before the process stops
   * waiting for it.
   *
   * It runs before anything is served, which is what makes it useful and also
   * what makes it dangerous: a container runtime that accepts a connection and
   * never answers would otherwise keep the platform from starting at all. The
   * work is not cancelled — what it has already written is correct and so is
   * what it writes afterwards — the process simply stops waiting.
   */
  RECOVERY_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(600_000).default(30_000),

  /**
   * Cleaning up what the platform made and then lost track of.
   *
   * Every leak this removes exists because somewhere a failure was preferred
   * over blocking: a project is deleted even when the host holding its container
   * is unreachable, because refusing to delete it would be worse. This is the
   * other half of that bargain.
   *
   * Runs in the worker process only. Several API instances sweeping at once
   * would enumerate and delete the same things.
   */
  ORPHAN_SWEEP_ENABLED: booleanish.default(true),
  ORPHAN_SWEEP_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(60_000)
    .max(24 * 60 * 60_000)
    .default(60 * 60_000),
  /**
   * How old something must be before it counts as abandoned.
   *
   * The single most important number here. A container exists for a moment
   * before the row recording it does, and an hour of slack makes that ordinary
   * race impossible to mistake for a leak. Anything whose age cannot be read is
   * treated as young and left alone.
   */
  ORPHAN_GRACE_MINUTES: z.coerce.number().int().min(5).max(10_080).default(60),
  /** Report what would be removed and remove nothing. */
  ORPHAN_SWEEP_DRY_RUN: booleanish.default(false),

  /**
   * What to do when the object store does not answer.
   *
   * Two mechanisms, and they answer different failures. Retrying handles a blip:
   * a reset connection, a moment of unavailability, where the same call a second
   * later succeeds. The breaker handles a sustained outage, where retrying makes
   * things worse — every request waiting out its attempts turns one dependency
   * being down into a control plane where everything is slow.
   *
   * The delays carry full jitter. Without it every caller that failed at the
   * same moment retries at the same moment, and the store coming back is met
   * with the entire backlog at once.
   */
  STORAGE_RETRY_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
  STORAGE_RETRY_BASE_MS: z.coerce.number().int().min(10).max(60_000).default(200),
  STORAGE_RETRY_MAX_MS: z.coerce.number().int().min(50).max(120_000).default(2_000),
  STORAGE_BREAKER_THRESHOLD: z.coerce.number().int().min(1).max(100).default(5),
  STORAGE_BREAKER_RESET_MS: z.coerce.number().int().min(1_000).max(600_000).default(30_000),

  /** S3-compatible object storage for project assets. */
  STORAGE_ENDPOINT: optional(z.url()),
  STORAGE_BUCKET: optional(z.string().min(1)),
  STORAGE_ACCESS_KEY: optional(z.string().min(1)),
  STORAGE_SECRET_KEY: optional(z.string().min(1)),
});

export type Env = z.infer<typeof envSchema>;

/** Keys whose values must never appear in logs or error output. */
const SENSITIVE_KEYS = new Set<string>([
  'DATABASE_URL',
  'REDIS_URL',
  'SESSION_SECRET',
  'SECRETS_ENCRYPTION_KEY',
  // Every key that ever sealed a secret, during a rotation.
  'SECRETS_PREVIOUS_KEYS',
  'STORAGE_ACCESS_KEY',
  'STORAGE_SECRET_KEY',
  // Missing until the verification pass: both carry a credential.
  'SMTP_PASSWORD',
  'USER_DATABASE_ADMIN_URL',
  'METRICS_TOKEN',
]);

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  /*
   * An empty value means "not set", for every key.
   *
   * `KEY=` in an env file and `KEY: ${KEY:-}` in a compose file both arrive as
   * an empty string. Treating that as a value made every optional setting —
   * mail, metrics — fail validation unless it was removed rather than left
   * blank, which is not how anybody fills in a template.
   */
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

/** Process-wide configuration, parsed once. */
export function env(): Env {
  cached ??= loadEnv();
  return cached;
}

/** Test-only: drop the memoised configuration. */
export function resetEnvCache(): void {
  cached = undefined;
}
