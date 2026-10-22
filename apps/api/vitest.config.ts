import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    fileParallelism: false,
    globalSetup: ['./tests/setup/global-setup.ts'],
    setupFiles: ['./tests/setup/network.ts'],
    testTimeout: 15_000,
  },
});
