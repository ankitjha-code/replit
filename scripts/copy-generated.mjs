// Copies Prisma's generated client into the build output.
//
// The client is generated into src/generated/prisma rather than node_modules,
// so the build must carry it across. tsc does not, because the generated
// output is JavaScript plus a WebAssembly query compiler, not TypeScript.
import { cpSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'api');
const from = resolve(packageRoot, 'src', 'generated');
const to = resolve(packageRoot, 'dist', 'generated');

if (!existsSync(from)) {
  console.error('Prisma client has not been generated. Run: pnpm db:generate');
  process.exit(1);
}

cpSync(from, to, { recursive: true });
console.log(`copied generated client -> ${to}`);
