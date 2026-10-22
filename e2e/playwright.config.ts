import { defineConfig, devices } from '@playwright/test';

const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 5173);
const API_PORT = Number(process.env.E2E_API_PORT ?? 4000);
const BASE_URL = process.env.E2E_BASE_URL ?? `http://localhost:${WEB_PORT}`;

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
  globalTeardown: './global-teardown.ts',
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      testIgnore: ['**/responsive.spec.ts', '**/theme.spec.ts'],
    },
    {
      name: 'phone',
      use: { ...devices['Pixel 7'], viewport: { width: 390, height: 844 } },
      testMatch: '**/responsive.spec.ts',
    },
    {
      name: 'light',
      use: { ...devices['Desktop Chrome'], colorScheme: 'light' },
      testMatch: '**/theme.spec.ts',
    },
  ],
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
        RATE_LIMIT_REGISTER_MAX: '200',
        RATE_LIMIT_LOGIN_MAX: '5000',
        RATE_LIMIT_PROJECT_CREATE_MAX: '200',
        RATE_LIMIT_RUNTIME_CONTROL_MAX: '200',
        RATE_LIMIT_GLOBAL_MAX: '10000',
        MAX_SOCKET_ATTEMPTS: '10000',
        MAX_SOCKETS_PER_USER: '200',
        RATE_LIMIT_ACCOUNT_MAX: '10000',
        RATE_LIMIT_MAIL_MAX: '200',
        EXECUTION_PROVIDER: 'docker',
        SECRETS_ENCRYPTION_KEY:
          process.env.SECRETS_ENCRYPTION_KEY ?? 'Zm9yLWJyb3dzZXItdGVzdHMtb25seS0zMi1ieXRlcyE=',
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
