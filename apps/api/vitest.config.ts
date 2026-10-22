import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    // Integration tests touch shared infrastructure; keep files serialized.
    fileParallelism: false,
    // Creates and migrates an isolated test database, so a suite never
    // truncates the developer's working data.
    globalSetup: ['./tests/setup/global-setup.ts'],
    setupFiles: ['./tests/setup/network.ts'],
    testTimeout: 15_000,
  },
});
