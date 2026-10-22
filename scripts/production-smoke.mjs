/**
 * An end-to-end walk through a production deployment, from outside, over HTTPS.
 *
 * Everything goes through the proxy exactly as a browser's requests would:
 * certificates are checked, previews and deployments are opened on their own
 * hostnames (so their certificates are issued on demand), and the live sockets
 * are secure WebSockets. Then the operator side: metrics from inside the
 * deployment, and a backup that is restored and compared.
 *
 *   NODE_EXTRA_CA_CERTS=<proxy root cert> node scripts/production-smoke.mjs
 *
 * Settings (environment):
 *   SMOKE_DOMAIN        the platform domain          (platform.localhost)
 *   SMOKE_STACK         compose project / name prefix (platform)
 *   SMOKE_METRICS_TOKEN the METRICS_TOKEN, to check /metrics from inside
 *   SMOKE_SKIP_BACKUP   set to skip the backup-and-restore check
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../apps/api/package.json', import.meta.url));
const { WebSocket } = require('ws');
const Y = require('yjs');

const DOMAIN = process.env.SMOKE_DOMAIN ?? 'platform.localhost';
const STACK = process.env.SMOKE_STACK ?? 'platform';
const ORIGIN = `https://${DOMAIN}`;
const suffix = Date.now().toString(36);

let cookie = '';
let failures = 0;

function check(label, condition, detail) {
  if (condition) console.log(`  ok   ${label}`);
  else {
    failures += 1;
    console.log(
      `  FAIL ${label}`,
      detail === undefined ? '' : JSON.stringify(detail).slice(0, 400),
    );
  }
}

async function call(method, path, body) {
  const response = await fetch(`${ORIGIN}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(cookie ? { cookie } : {}),
      origin: ORIGIN,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const set = response.headers.get('set-cookie');
  if (set?.startsWith('platform_session=')) cookie = set.split(';')[0];
  const text = await response.text();
  let json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = text;
  }
  return { status: response.status, body: json, headers: response.headers };
}

async function eventually(read, done, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await read();
      if (done(last)) return last;
    } catch (error) {
      last = String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return last;
}

function docker(...args) {
  return execFileSync('docker', args, { encoding: 'utf8' }).trim();
}

// ---------------------------------------------------------------------------
console.log(`\nFront door (${ORIGIN})`);
const ready = await call('GET', '/health/ready');
check('ready over HTTPS with a trusted certificate', ready.status === 200, ready.body);
check(
  'every dependency is up',
  Array.isArray(ready.body?.dependencies) &&
    ready.body.dependencies.every((d) => d.status === 'up'),
  ready.body?.dependencies,
);
const page = await fetch(`${ORIGIN}/`);
check('serves the web app', (await page.text()).includes('<title>Workspace</title>'));
check('with HSTS', Boolean(page.headers.get('strict-transport-security')));
check('hides /metrics from the public', (await fetch(`${ORIGIN}/metrics`)).status === 404);

// ---------------------------------------------------------------------------
console.log('\nAccount and project');
const registered = await call('POST', '/api/auth/register', {
  email: `prod-${suffix}@example.test`,
  username: `prod-${suffix}`,
  password: 'a-long-production-passphrase-1',
});
check('registers', registered.status === 201, registered.body);
check(
  'with a Secure session cookie',
  /;\s*Secure/i.test(registered.headers.get('set-cookie') ?? ''),
);

const project = await call('POST', '/api/projects', { name: `Prod ${suffix}` });
check('creates a project', project.status === 201, project.body);
const projectId = project.body?.project?.id;
const base = `/api/projects/${projectId}`;

const program = `const http = require('http');
http.createServer((q, s) => s.end('hello from production')).listen(3000, () => console.log('listening on 3000'));`;
check(
  'writes files',
  (await call('PUT', `${base}/files/content`, { path: 'index.js', content: program })).status <
    300 &&
    (
      await call('PUT', `${base}/files/content`, {
        path: 'package.json',
        content: '{"name":"prod","scripts":{"start":"node index.js"}}',
      })
    ).status < 300,
);

// ---------------------------------------------------------------------------
console.log('\nLive sockets (wss through the proxy)');
function socket(path) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`wss://${DOMAIN}${path}`, { headers: { cookie, origin: ORIGIN } });
    ws.binaryType = 'arraybuffer';
    ws.on('open', () => resolve({ ws }));
    ws.on('unexpected-response', (_req, res) => resolve({ status: res.statusCode }));
    ws.on('error', (error) => resolve({ error: String(error) }));
  });
}
const events = await socket(`/ws/projects/${projectId}/events`);
check('the events socket connects', Boolean(events.ws), events);
events.ws?.close();

const doc = await socket(`/ws/projects/${projectId}/document?path=index.js`);
check('the document socket connects', Boolean(doc.ws), doc);
if (doc.ws) {
  const ydoc = new Y.Doc();
  const synced = new Promise((resolve) => {
    doc.ws.on('message', (data, binary) => {
      const bytes = new Uint8Array(data);
      if (binary && bytes[0] === 1) resolve(bytes.subarray(1));
    });
    setTimeout(() => resolve(undefined), 10_000);
  });
  const vector = Y.encodeStateVector(ydoc);
  const frame = new Uint8Array(vector.length + 1);
  frame[0] = 0;
  frame.set(vector, 1);
  doc.ws.send(frame);
  const update = await synced;
  if (update) Y.applyUpdate(ydoc, update);
  check(
    'and hands over the file for live editing',
    ydoc.getText('content').toString().includes('hello from production'),
  );
  doc.ws.close();
}

// ---------------------------------------------------------------------------
console.log('\nRunning code (a real container, started by the worker)');
check('asks for an environment', (await call('POST', `${base}/runtime/start`, {})).status < 300);
const runtime = await eventually(
  () => call('GET', `${base}/runtime`),
  (r) => ['RUNNING', 'FAILED'].includes(r.body?.runtime?.status),
  300_000,
);
check('the environment comes up', runtime.body?.runtime?.status === 'RUNNING', runtime.body);

await call('PUT', `${base}/runtime/run/command`, { command: 'node index.js' });
check('starts the program', (await call('POST', `${base}/runtime/run/start`, {})).status < 300);
const running = await eventually(
  () => call('GET', `${base}/runtime/run`),
  (r) => r.body?.status === 'RUNNING' || r.body?.status === 'FAILED',
  60_000,
);
check('the program is running', running.body?.status === 'RUNNING', running.body);

console.log('\nPreview (its own hostname, certificate issued on demand)');
const state = await eventually(
  () => call('GET', `${base}/preview`),
  (r) => typeof r.body?.url === 'string',
  60_000,
);
check('the preview has an https address', /^https:\/\//.test(state.body?.url ?? ''), state.body);
const grant = await call('POST', `${base}/preview/grant`, {});
check('a grant is issued', typeof grant.body?.url === 'string', grant.body);
if (typeof grant.body?.url === 'string') {
  const redeemed = await fetch(grant.body.url, { redirect: 'manual' });
  const viewing = (redeemed.headers.get('set-cookie') ?? '').split(';')[0];
  check('redeeming it sets a viewing cookie', redeemed.status === 302 && Boolean(viewing));
  const shown = await fetch(new URL('/', grant.body.url), { headers: { cookie: viewing } });
  check(
    'the preview shows the running program, over HTTPS',
    (await shown.text()).includes('hello from production'),
  );
}

// ---------------------------------------------------------------------------
console.log('\nHistory (object storage)');
const committed = await call('POST', `${base}/git/commits`, { message: 'first' });
check('commits', committed.status === 201, committed.body);
const snapshot = await call('POST', `${base}/snapshots`, { name: 'before deploy' });
check('takes a snapshot', snapshot.status === 201, snapshot.body);

// ---------------------------------------------------------------------------
console.log('\nDeployment (public, its own hostname, certificate issued on demand)');
await call('POST', `${base}/runtime/run/stop`, {});
const configured = await call('PUT', `${base}/deployments/config`, {
  target: 'SERVER',
  buildCommand: null,
  outputDirectory: null,
  startCommand: 'node index.js',
});
check('configures a server deployment', configured.status === 200, configured.body);
const deployed = await call('POST', `${base}/deployments`, { note: 'smoke' });
check('asks for a deployment', deployed.status < 300, deployed.body);
const live = await eventually(
  () => call('GET', `${base}/deployments`),
  (r) =>
    ['RUNNING', 'FAILED'].includes(r.body?.deployments?.[0]?.status ?? r.body?.current?.status),
  300_000,
);
const current = live.body?.deployments?.[0] ?? live.body?.current;
check('the deployment is running', current?.status === 'RUNNING', live.body);
const address = current?.url ?? live.body?.url;
if (typeof address === 'string') {
  const publicPage = await eventually(
    () => fetch(address).then((r) => r.text()),
    (text) => typeof text === 'string' && text.includes('hello from production'),
    30_000,
  );
  check(
    `anyone can open it at ${address}`,
    typeof publicPage === 'string' && publicPage.includes('hello from production'),
    publicPage,
  );
} else {
  check('the deployment has an address', false, live.body);
}

// ---------------------------------------------------------------------------
console.log('\nOperator side');
if (process.env.SMOKE_METRICS_TOKEN) {
  const metrics = docker(
    'exec',
    `${STACK}-proxy`,
    'wget',
    '-qO-',
    '--header',
    `Authorization: Bearer ${process.env.SMOKE_METRICS_TOKEN}`,
    'http://172.31.250.1:4000/metrics',
  );
  check('metrics are served inside the deployment', metrics.includes('platform_projects'));
  check(
    'and count what is running',
    /platform_runtimes\{status="RUNNING"\} [1-9]/.test(metrics),
    metrics.split('\n').filter((l) => l.startsWith('platform_runtimes')),
  );
}

if (!process.env.SMOKE_SKIP_BACKUP) {
  const out = docker('exec', `${STACK}-backup`, '/usr/local/bin/backup-once.sh');
  const file = /platform database -> (\S+)/.exec(out)?.[1];
  check('a backup is taken and verified', Boolean(file), out);
  if (file) {
    const count = (db) =>
      docker(
        'exec',
        `${STACK}-postgres`,
        'psql',
        '-U',
        'platform',
        '-d',
        db,
        '-tAc',
        "select (select count(*) from users) || ',' || (select count(*) from projects) || ',' || (select count(*) from project_files)",
      );
    docker('exec', `${STACK}-postgres`, 'dropdb', '-U', 'platform', '--if-exists', 'restore_check');
    docker('exec', `${STACK}-postgres`, 'createdb', '-U', 'platform', 'restore_check');
    docker(
      'exec',
      '-e',
      'RESTORE_CONFIRM=yes',
      '-e',
      'RESTORE_DB_NAME=restore_check',
      `${STACK}-backup`,
      '/usr/local/bin/restore-platform.sh',
      file,
    );
    const original = count('platform');
    const restored = count('restore_check');
    check(`the restored copy matches (users,projects,files = ${original})`, original === restored, {
      original,
      restored,
    });
    docker('exec', `${STACK}-postgres`, 'dropdb', '-U', 'platform', 'restore_check');
  }
}

// ---------------------------------------------------------------------------
console.log('\nCleaning up');
const deleted = await call('DELETE', '/api/account', {
  password: 'a-long-production-passphrase-1',
  confirmUsername: `prod-${suffix}`,
});
check('closes the account and its project', deleted.status === 200, deleted.body);

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
