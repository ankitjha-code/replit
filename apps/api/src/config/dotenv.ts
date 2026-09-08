import { existsSync } from 'node:fs';
import { dirname, join, parse } from 'node:path';

/**
 * Loads the repository's .env into process.env.
 *
 * The API runs from apps/api but configuration lives at the repository root,
 * so the file is found by walking upward. Node's own loader gives real
 * environment variables precedence over file entries, which is the precedence
 * we want: a value exported in the shell or set by the container wins.
 *
 * Skipped under NODE_ENV=test so a test run never depends on whatever happens
 * to be in a developer's .env. Tests pass configuration explicitly.
 */
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
