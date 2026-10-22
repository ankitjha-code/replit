// Creates .env from .env.example when it is missing.
//
// Docker Compose fails with a cryptic error if the file named by --env-file
// does not exist, and a first-time contributor should not have to decode that.
// An existing .env is never touched.
import { copyFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = resolve(root, '.env');
const template = resolve(root, '.env.example');

if (existsSync(target)) {
  process.exit(0);
}

if (!existsSync(template)) {
  console.error('.env.example is missing; cannot create .env');
  process.exit(1);
}

copyFileSync(template, target);
console.log('Created .env from .env.example. Review it before running outside your machine.');
