import { defineConfig, devices } from '@playwright/test';

const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 5173);
const API_PORT = Number(process.env.E2E_API_PORT ?? 4000);
const BASE_URL = process.env.E2E_BASE_URL ?? `http://localhost:${WEB_PORT}`;

/**
 * End-to-end runs drive the real stack: the real control plane, the real
 * database, and a real browser.
 *
 * Both servers are started as plain `node` processes rather than through the
 * package manager's dev scripts. Two reasons, both learned the hard way:
 *
 *  - A `pnpm run` chain is a shell spawning a watcher spawning node, and on
 *    Windows terminating the shell leaves the grandchild alive, holding the
 *    port and blocking the next run.
 *  - Reusing a leftover server means inheriting its state. Its rate-limit
 *    counters are already spent and its configuration is whatever the previous
 *    run used, which made results depend on what happened to be running.
 *
 * The consequence is that these tests exercise the built output, which is
 * closer to what actually gets deployed than a watcher ever is. Run
 * `pnpm build` first; `pnpm test:e2e` from the repository root does.
 */
export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  timeout: 30_000,
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  // Closes every test account afterwards, so no run leaves containers behind.
  globalTeardown: './global-teardown.ts',
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'node apps/api/dist/index.js',
      url: `http://localhost:${API_PORT}/health/live`,
      reuseExistingServer: false,
      timeout: 60_000,
      cwd: '..',
      env: {
        ...process.env,
        API_PORT: String(API_PORT),
        NODE_ENV: 'development',
        // The whole suite acts from one address, which the production
        // defaults are designed to stop: a handful of registrations per 15
        // minutes, twenty projects per hour. Raised, not disabled. The
        // limiters still run, and their behaviour is covered by the API
        // integration tests where the counts can be controlled exactly.
        RATE_LIMIT_REGISTER_MAX: '200',
        // Also covers the teardown signing in to every test account.
        RATE_LIMIT_LOGIN_MAX: '5000',
        RATE_LIMIT_PROJECT_CREATE_MAX: '200',
        RATE_LIMIT_RUNTIME_CONTROL_MAX: '200',
        // The ceilings added later, in tasks 54 and 55, raised for the same
        // reason. Left at their defaults, one address running the whole suite
        // trips the per-address WebSocket-attempt window long before any real
        // client would.
        RATE_LIMIT_GLOBAL_MAX: '10000',
        MAX_SOCKET_ATTEMPTS: '10000',
        MAX_SOCKETS_PER_USER: '200',
        RATE_LIMIT_ACCOUNT_MAX: '10000',
        RATE_LIMIT_MAIL_MAX: '200',
        // The browser suite runs against a real container backend, because
        // "pressing Run starts something" is not a claim a mock can support.
        // The refusal path an installation without one gives is covered by the
        // API integration tests, which use the default provider.
        EXECUTION_PROVIDER: 'docker',
        // Assets and secrets both need somewhere to put things: an object
        // store and an encryption key. Fixed here rather than generated, so a
        // rerun can still read what the last run wrote.
        SECRETS_ENCRYPTION_KEY:
          process.env.SECRETS_ENCRYPTION_KEY ?? 'Zm9yLWJyb3dzZXItdGVzdHMtb25seS0zMi1ieXRlcyE=',
        /*
         * The same network the rest of the platform uses, not one of its own.
         *
         * It used to be separate, to keep test containers away from whatever a
         * developer had running. Since task 26 the user database server sits on
         * the runtime network, and a container on a network of its own cannot
         * reach it, so the isolation would have cost the suite the ability to
         * test the thing at all.
         */
        RUNTIME_NETWORK: process.env.RUNTIME_NETWORK ?? 'platform-runtimes',
      },
    },
    {
      command: `node node_modules/vite/bin/vite.js preview --port ${WEB_PORT} --strictPort`,
      url: BASE_URL,
      reuseExistingServer: false,
      timeout: 60_000,
      cwd: '../apps/web',
      env: {
        ...process.env,
        VITE_API_PROXY_TARGET: `http://localhost:${API_PORT}`,
      },
    },
  ],
});
