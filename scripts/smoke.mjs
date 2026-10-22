/**
 * An end-to-end walk through a running installation, over real HTTP.
 *
 * Not a test suite: it is what a person would do in the first ten minutes, done
 * against the processes as they actually run — the API, the worker, Docker,
 * MinIO, the project database server and Mailpit — so that "it starts" means
 * something more than "it did not crash".
 *
 *   node scripts/smoke.mjs            (API on :4000, Mailpit on :8025)
 */
const API = process.env.SMOKE_API ?? 'http://localhost:4000';
const MAILPIT = process.env.SMOKE_MAILPIT ?? 'http://localhost:8025';

let cookie = '';
let failures = 0;
const suffix = Date.now().toString(36);

async function call(method, path, body) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(cookie ? { cookie } : {}),
      origin: 'http://localhost:5173',
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
  return { status: response.status, body: json };
}

function check(label, condition, detail) {
  if (condition) console.log(`  ok   ${label}`);
  else {
    failures += 1;
    console.log(
      `  FAIL ${label}`,
      detail === undefined ? '' : JSON.stringify(detail).slice(0, 300),
    );
  }
}

async function eventually(read, done, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!done(value) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1_000));
    value = await read();
  }
  return value;
}

async function latestMailTo(address) {
  const list = await (
    await fetch(`${MAILPIT}/api/v1/search?query=to:${encodeURIComponent(address)}`)
  ).json();
  const id = list.messages?.[0]?.ID;
  if (!id) return undefined;
  return (await fetch(`${MAILPIT}/api/v1/message/${id}`)).json();
}

const email = `smoke-${suffix}@example.test`;

console.log('\nAccount');
const registered = await call('POST', '/api/auth/register', {
  email,
  username: `smoke-${suffix}`,
  password: 'a-long-smoke-passphrase-1',
});
check('registers and signs in', registered.status === 201, registered.body);

const verification = await call('GET', '/api/auth/verification');
check('says mail can be sent here', verification.body?.canSend === true, verification.body);

const sent = await call('POST', '/api/auth/verification/send');
check('sends a verification link', sent.status === 202, sent.body);
const message = await eventually(() => latestMailTo(email), Boolean, 15_000);
const token = /token=([A-Za-z0-9_-]+)/.exec(message?.Text ?? '')?.[1];
check('the link arrives in the mailbox', Boolean(token), message?.Text);
const confirmed = await call('POST', '/api/auth/verification/confirm', { token });
check('the link verifies the address', confirmed.status === 200, confirmed.body);
check(
  'the account now says so',
  (await call('GET', '/api/auth/me')).body?.user?.emailVerified === true,
);

const sessions = await call('GET', '/api/account/sessions');
check(
  'lists its own session, without a credential',
  sessions.body?.sessions?.length === 1 && !JSON.stringify(sessions.body).includes('tokenHash'),
  sessions.body,
);
check(
  'operations are not found for an ordinary account',
  (await call('GET', '/api/operations/overview')).status === 404,
);

console.log('\nProject');
const project = await call('POST', '/api/projects', { name: `Smoke ${suffix}` });
check('creates a project', project.status === 201, project.body);
const projectId = project.body?.project?.id;
const base = `/api/projects/${projectId}`;

const program = `const http = require('http');
http.createServer((q, s) => s.end('hello from the smoke test')).listen(3000, () => console.log('listening on 3000'));`;
check(
  'writes a file',
  (await call('PUT', `${base}/files/content`, { path: 'index.js', content: program })).status < 300,
);
check(
  'writes a manifest',
  (
    await call('PUT', `${base}/files/content`, {
      path: 'package.json',
      content: '{"name":"smoke","scripts":{"start":"node index.js"}}',
    })
  ).status < 300,
);

console.log('\nRunning it (a real container, started by the worker)');
const started = await call('POST', `${base}/runtime/start`, {});
check('asks for an environment', started.status < 300, started.body);
const runtime = await eventually(
  () => call('GET', `${base}/runtime`),
  (r) => ['RUNNING', 'FAILED'].includes(r.body?.runtime?.status),
  240_000,
);
check('the environment comes up', runtime.body?.runtime?.status === 'RUNNING', runtime.body);

await call('PUT', `${base}/runtime/run/command`, { command: 'node index.js' });
const run = await call('POST', `${base}/runtime/run/start`, {});
check('starts the program', run.status < 300, run.body);
const running = await eventually(
  () => call('GET', `${base}/runtime/run`),
  (r) => r.body?.status === 'RUNNING' || r.body?.status === 'FAILED',
  60_000,
);
check('the program is running', running.body?.status === 'RUNNING', running.body);

const preview = await eventually(
  () => call('GET', `${base}/preview`),
  (r) => r.body?.ready === true || r.body?.status === 'ready',
  60_000,
);
check(
  'the preview finds the port it opened',
  JSON.stringify(preview.body).includes('3000'),
  preview.body,
);

console.log('\nCleaning up');
check('stops the program', (await call('POST', `${base}/runtime/run/stop`, {})).status < 300);
check('stops the environment', (await call('POST', `${base}/runtime/stop`, {})).status < 300);
const deleted = await call('DELETE', '/api/account', {
  password: 'a-long-smoke-passphrase-1',
  confirmUsername: `smoke-${suffix}`,
});
check(
  'closes the account, and its project with it',
  deleted.status === 200 && deleted.body?.projectsDeleted === 1,
  deleted.body,
);

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
