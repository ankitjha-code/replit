import { createRequire } from 'node:module';

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
