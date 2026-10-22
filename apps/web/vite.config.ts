import { createRequire } from 'node:module';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

const monacoApi = createRequire(import.meta.url)
  .resolve('monaco-editor')
  .replace(/min[/\\]vs[/\\]index\.js$/, 'esm/vs/editor/editor.api.js');

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const apiTarget = env.VITE_API_PROXY_TARGET ?? 'http://localhost:4000';

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
      testTimeout: 20_000,
    },
  };
});
