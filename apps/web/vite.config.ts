import { createRequire } from 'node:module';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Where Monaco's editor API actually lives.
 *
 * `y-monaco` imports it as `monaco-editor/esm/vs/editor/editor.api.js`, which
 * was the path before Monaco published an export map. Under the map,
 * `monaco-editor/*` resolves inside `esm/vs`, so that specifier now points at
 * `esm/vs/esm/vs/...` and resolves to nothing. Resolved from the package's own
 * entry point rather than written out, so it follows wherever the installer put
 * it and breaks loudly rather than silently if the file ever moves.
 */
const monacoApi = createRequire(import.meta.url)
  .resolve('monaco-editor')
  .replace(/min[/\\]vs[/\\]index\.js$/, 'esm/vs/editor/editor.api.js');

/**
 * The dev server proxies the control plane so the browser sees a single
 * origin. That keeps cookie-based sessions and WebSocket upgrades working the
 * same way in development as they do behind the production reverse proxy.
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const apiTarget = env.VITE_API_PROXY_TARGET ?? 'http://localhost:4000';

  // Shared by the dev server and by `vite preview`, so the built app behaves
  // the same way end-to-end tests and production do: one origin, with the
  // control plane behind it.
  const proxy = {
    '/api': { target: apiTarget, changeOrigin: true },
    '/health': { target: apiTarget, changeOrigin: true },
    '/ws': { target: apiTarget, changeOrigin: true, ws: true },
  };

  return {
    plugins: [react()],
    resolve: {
      alias: [
        {
          find: 'monaco-editor/esm/vs/editor/editor.api.js',
          replacement: monacoApi,
        },
      ],
    },
    server: {
      // The reverse proxy runs in a container and reaches the host through
      // the gateway address, so a loopback-only bind is unreachable from it.
      // allowedHosts below keeps that from becoming a DNS-rebinding hole.
      host: env.VITE_HOST ?? '0.0.0.0',
      port: Number(env.VITE_PORT ?? 5173),
      strictPort: true,
      allowedHosts: ['localhost', '127.0.0.1', 'host.docker.internal'],
      proxy,
    },
    preview: {
      host: env.VITE_HOST ?? '0.0.0.0',
      port: Number(env.VITE_PORT ?? 5173),
      strictPort: true,
      allowedHosts: ['localhost', '127.0.0.1', 'host.docker.internal'],
      proxy,
    },
    build: {
      outDir: 'dist',
      sourcemap: true,
    },
    test: {
      environment: 'jsdom',
      globals: true,
      setupFiles: ['./vitest.setup.ts'],
      include: ['src/**/*.test.{ts,tsx}'],
      /*
       * Well above what any single test needs.
       *
       * These suites type character by character in real time, and the files
       * run in parallel on one machine. Under that contention a test that
       * takes two seconds alone can take several, and the default five second
       * budget started failing tests that were not broken. Worse, a timed-out
       * `userEvent` keeps typing into whatever renders next, so one slow test
       * corrupts the one after it and the reported failure names the wrong
       * test entirely.
       */
      testTimeout: 20_000,
    },
  };
});
