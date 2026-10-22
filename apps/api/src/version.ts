import { createRequire } from 'node:module';

/**
 * Read from the package manifest at runtime rather than duplicated as a
 * constant, so the reported version cannot drift from the published one.
 * Resolves identically from `src/` (tsx) and `dist/` (built output).
 */
const require = createRequire(import.meta.url);

interface Manifest {
  version?: unknown;
}

function read(): string {
  try {
    const manifest = require('../package.json') as Manifest;
    return typeof manifest.version === 'string' ? manifest.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const APP_VERSION = read();
