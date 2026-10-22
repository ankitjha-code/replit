import { existsSync } from 'node:fs';
import { dirname, join, parse } from 'node:path';

export function loadDotEnv(startDir: string = process.cwd()): string | undefined {
  if (process.env.NODE_ENV === 'test') return undefined;

  const found = findUp('.env', startDir);
  if (!found) return undefined;

  process.loadEnvFile(found);
  return found;
}

function findUp(filename: string, startDir: string): string | undefined {
  const { root } = parse(startDir);
  let dir = startDir;

  for (;;) {
    const candidate = join(dir, filename);
    if (existsSync(candidate)) return candidate;
    if (dir === root) return undefined;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}
