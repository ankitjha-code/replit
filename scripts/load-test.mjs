/**
 * How much one installation can take, measured from outside over HTTPS.
 *
 *   NODE_EXTRA_CA_CERTS=<proxy root cert, for a local CA> node scripts/load-test.mjs
 *
 * Four measurements, each through the public proxy exactly as browsers use it:
 *
 *   1. steady   — LOAD_USERS people each doing about one thing a second
 *                 (list, open, save, status). Latency and errors at a realistic pace.
 *   2. stress   — the same people with no pause at all: maximum throughput, and
 *                 where errors or the platform's own rate limits start.
 *   3. sockets  — LOAD_SOCKETS live project connections held open at once.
 *   4. environments — LOAD_ENVIRONMENTS real containers started together, each
 *                 running a small web server; how long each took and whether any
 *                 failed, then memory per environment.
 *
 * Accounts it creates are closed afterwards. Needs the registration, project
 * creation, runtime control and account limits raised for the run
 * (deploy/api.env: RATE_LIMIT_REGISTER_MAX, RATE_LIMIT_PROJECT_CREATE_MAX,
 * RATE_LIMIT_RUNTIME_CONTROL_MAX, RATE_LIMIT_ACCOUNT_MAX). Every user comes
 * from one address, so without the last one only five accounts are closed and
 * the rest — projects, containers, networks — stay behind; the run then fails.
 *
 * Settings: LOAD_DOMAIN (platform.localhost), LOAD_USERS (40),
 * LOAD_STEADY_S (60), LOAD_STRESS_S (30), LOAD_SOCKETS (200),
 * LOAD_ENVIRONMENTS (20), LOAD_STACK (platform; for `docker stats`).
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../apps/api/package.json', import.meta.url));
const { WebSocket } = require('ws');

const DOMAIN = process.env.LOAD_DOMAIN ?? 'platform.localhost';
const ORIGIN = `https://${DOMAIN}`;
const USERS = Number(process.env.LOAD_USERS ?? 40);
const STEADY_S = Number(process.env.LOAD_STEADY_S ?? 60);
const STRESS_S = Number(process.env.LOAD_STRESS_S ?? 30);
const SOCKETS = Number(process.env.LOAD_SOCKETS ?? 200);
const ENVIRONMENTS = Number(process.env.LOAD_ENVIRONMENTS ?? 20);
const PASSWORD = 'a-long-load-test-passphrase-1';
const run = Date.now().toString(36);

async function call(user, method, path, body) {
  const started = performance.now();
  let status = 0;
  try {
    const response = await fetch(`${ORIGIN}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(user?.cookie ? { cookie: user.cookie } : {}),
        origin: ORIGIN,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    status = response.status;
    const set = response.headers.get('set-cookie');
    if (user && set?.startsWith('platform_session=')) user.cookie = set.split(';')[0];
    const text = await response.text();
    return { status, ms: performance.now() - started, body: text ? safeJson(text) : undefined };
  } catch (error) {
    return { status, ms: performance.now() - started, error: String(error) };
  }
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

function summarise(samples, seconds) {
  const ok = samples.filter((s) => s.status >= 200 && s.status < 400);
  const limited = samples.filter((s) => s.status === 429).length;
  const failed = samples.length - ok.length - limited;
  const ms = ok.map((s) => s.ms).sort((a, b) => a - b);
  return {
    requests: samples.length,
    perSecond: Math.round(samples.length / seconds),
    ok: ok.length,
    rateLimited: limited,
    failed,
    errorRate: `${((failed / Math.max(samples.length, 1)) * 100).toFixed(2)}%`,
    p50ms: Math.round(percentile(ms, 50)),
    p95ms: Math.round(percentile(ms, 95)),
    p99ms: Math.round(percentile(ms, 99)),
    maxMs: Math.round(ms.at(-1) ?? 0),
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** One user's cycle: what a person with a project open actually does. */
async function cycle(user, samples) {
  const base = `/api/projects/${user.projectId}`;
  samples.push(await call(user, 'GET', '/api/projects'));
  samples.push(await call(user, 'GET', `${base}/files`));
  samples.push(await call(user, 'GET', `${base}/files/content?path=index.js`));
  samples.push(
    await call(user, 'PUT', `${base}/files/content`, {
      path: 'notes.md',
      content: `saved at ${Date.now()}`,
      encoding: 'utf8',
    }),
  );
  samples.push(await call(user, 'GET', `${base}/runtime`));
}

async function phase(name, seconds, pauseMs) {
  const samples = [];
  const until = Date.now() + seconds * 1000;
  await Promise.all(
    users.map(async (user) => {
      while (Date.now() < until) {
        await cycle(user, samples);
        if (pauseMs) await sleep(pauseMs);
      }
    }),
  );
  const result = summarise(samples, seconds);
  console.log(`\n${name}`);
  console.table(result);
  return result;
}

function containerMemory() {
  const stack = process.env.LOAD_STACK ?? 'platform';
  try {
    const lines = execFileSync(
      'docker',
      ['stats', '--no-stream', '--format', '{{.Name}}\t{{.MemUsage}}\t{{.CPUPerc}}'],
      { encoding: 'utf8' },
    )
      .trim()
      .split('\n');
    const parse = (text) => {
      const [value, unit] = [parseFloat(text), text.replace(/[\d.]/g, '')];
      return value * ({ KiB: 1 / 1024, MiB: 1, GiB: 1024, B: 1 / 1048576 }[unit] ?? 1);
    };
    const rows = lines.map((line) => {
      const [name, mem, cpu] = line.split('\t');
      return { name, mb: parse(mem.split(' / ')[0]), cpu: parseFloat(cpu) };
    });
    const sum = (filter) => rows.filter(filter).reduce((acc, row) => acc + row.mb, 0);
    return {
      environmentsMb: Math.round(sum((r) => r.name.startsWith('platform-runtime-'))),
      environments: rows.filter((r) => r.name.startsWith('platform-runtime-')).length,
      apiMb: Math.round(sum((r) => r.name === `${stack}-api`)),
      workerMb: Math.round(sum((r) => r.name === `${stack}-worker`)),
      postgresMb: Math.round(sum((r) => r.name === `${stack}-postgres`)),
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
console.log(`Load test against ${ORIGIN}: ${USERS} users`);
const users = [];
for (let index = 0; index < USERS; index += 1) {
  const user = { name: `load-${run}-${index}` };
  const registered = await call(user, 'POST', '/api/auth/register', {
    email: `${user.name}@example.test`,
    username: user.name,
    password: PASSWORD,
  });
  if (registered.status !== 201) {
    console.error(
      'registration refused — raise RATE_LIMIT_REGISTER_MAX in deploy/api.env',
      registered,
    );
    process.exit(1);
  }
  const project = await call(user, 'POST', '/api/projects', { name: `Load ${index}` });
  user.projectId = project.body?.project?.id;
  await call(user, 'PUT', `/api/projects/${user.projectId}/files/content`, {
    path: 'index.js',
    content:
      "require('http').createServer((q, s) => s.end('ok')).listen(3000, () => console.log('up'));",
    encoding: 'utf8',
  });
  await call(user, 'PUT', `/api/projects/${user.projectId}/files/content`, {
    path: 'package.json',
    content: '{"name":"load"}',
    encoding: 'utf8',
  });
  users.push(user);
}
console.log(`created ${users.length} accounts and projects`);

const results = { at: new Date().toISOString(), domain: ORIGIN, users: USERS };
results.steady = await phase(
  `1. Steady use: ${USERS} people, ~1 action a second each`,
  STEADY_S,
  1000,
);
results.stress = await phase(`2. Stress: ${USERS} people, no pauses`, STRESS_S, 0);

// ---------------------------------------------------------------------------
console.log(`\n3. Live connections: ${SOCKETS} project sockets`);
const sockets = [];
const opened = await Promise.all(
  Array.from({ length: SOCKETS }, (_, index) => {
    const user = users[index % users.length];
    return new Promise((resolve) => {
      const started = performance.now();
      const ws = new WebSocket(`wss://${DOMAIN}/ws/projects/${user.projectId}/events`, {
        headers: { cookie: user.cookie, origin: ORIGIN },
      });
      sockets.push(ws);
      ws.on('open', () => resolve({ ok: true, ms: performance.now() - started }));
      ws.on('unexpected-response', (_req, res) => resolve({ ok: false, status: res.statusCode }));
      ws.on('error', () => resolve({ ok: false }));
    });
  }),
);
await sleep(10_000);
const stillOpen = sockets.filter((ws) => ws.readyState === WebSocket.OPEN).length;
results.sockets = {
  asked: SOCKETS,
  opened: opened.filter((o) => o.ok).length,
  refused: opened.filter((o) => !o.ok).length,
  stillOpenAfter10s: stillOpen,
  refusedStatuses: [...new Set(opened.filter((o) => !o.ok).map((o) => o.status))],
};
console.table(results.sockets);
for (const ws of sockets) ws.close();

// ---------------------------------------------------------------------------
const wanted = Math.min(ENVIRONMENTS, users.length);
console.log(`\n4. Environments: starting ${wanted} at once, each running a web server`);
const memoryBefore = containerMemory();
const envStart = await Promise.all(
  users.slice(0, wanted).map(async (user) => {
    const started = performance.now();
    const asked = await call(user, 'POST', `/api/projects/${user.projectId}/runtime/start`, {});
    if (asked.status >= 300)
      return { ok: false, reason: asked.body?.error?.message ?? asked.status };
    for (;;) {
      const state = await call(user, 'GET', `/api/projects/${user.projectId}/runtime`);
      const status = state.body?.runtime?.status;
      if (status === 'RUNNING') break;
      if (status === 'FAILED' || performance.now() - started > 300_000) {
        return { ok: false, reason: state.body?.runtime?.message ?? status ?? 'timeout' };
      }
      await sleep(1_000);
    }
    const ready = performance.now() - started;
    await call(user, 'PUT', `/api/projects/${user.projectId}/runtime/run/command`, {
      command: 'node index.js',
    });
    await call(user, 'POST', `/api/projects/${user.projectId}/runtime/run/start`, {});
    return { ok: true, seconds: ready / 1000 };
  }),
);
await sleep(15_000);
const memoryAfter = containerMemory();
const times = envStart
  .filter((e) => e.ok)
  .map((e) => e.seconds)
  .sort((a, b) => a - b);
results.environments = {
  asked: wanted,
  running: times.length,
  failed: envStart.length - times.length,
  failureReasons: [...new Set(envStart.filter((e) => !e.ok).map((e) => String(e.reason)))],
  startSecondsP50: Number(percentile(times, 50)?.toFixed(1) ?? 0),
  startSecondsMax: Number((times.at(-1) ?? 0).toFixed(1)),
  memoryPerEnvironmentMb:
    memoryAfter && memoryAfter.environments > 0
      ? Math.round(memoryAfter.environmentsMb / memoryAfter.environments)
      : null,
};
console.table(results.environments);
results.memory = { before: memoryBefore, after: memoryAfter };
console.log('memory (MB):', JSON.stringify(results.memory));

// ---------------------------------------------------------------------------
console.log('\nCleaning up');
const notClosed = [];
for (const user of users) {
  await call(user, 'POST', `/api/projects/${user.projectId}/runtime/stop`, {});
  const closed = await call(user, 'DELETE', '/api/account', {
    password: PASSWORD,
    confirmUsername: user.name,
  });
  if (closed.status !== 200) notClosed.push(`${user.name}: ${closed.status}`);
}
results.accountsNotClosed = notClosed.length;
if (notClosed.length > 0) {
  console.error(
    `${notClosed.length} accounts could not be closed (429 means raise RATE_LIMIT_ACCOUNT_MAX):`,
    notClosed.slice(0, 5),
  );
  process.exitCode = 1;
}
const file = process.env.LOAD_RESULTS ?? `load-test-${run}.json`;
writeFileSync(file, `${JSON.stringify(results, null, 2)}\n`);
console.log(`results written to ${file}`);
