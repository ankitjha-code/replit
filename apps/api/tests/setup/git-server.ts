import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A real git server for tests: `git http-backend` behind a small HTTP server,
 * serving bare repositories in a temporary directory.
 *
 * Test infrastructure only. It runs the developer's own `git` binary on fixed
 * arguments, never anything a test user typed, and exists so push and pull are
 * exercised against the real smart-HTTP protocol rather than a stub of it.
 */

export function hasGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export interface GitServer {
  url(repository: string): string;
  /** Makes an empty bare repository that accepts pushes. */
  create(repository: string): void;
  /** Runs a read-only git command against a bare repository, for assertions. */
  git(repository: string, ...args: string[]): string;
  /** Every Authorization header received, to prove credentials were sent. */
  authorizations: string[];
  close(): Promise<void>;
}

export async function startGitServer(options: { requireAuth?: string } = {}): Promise<GitServer> {
  const root = mkdtempSync(join(tmpdir(), 'platform-git-'));
  const authorizations: string[] = [];

  const server: Server = createServer((req, res) => {
    const header = req.headers.authorization;
    if (header) authorizations.push(header);

    if (
      options.requireAuth &&
      header !== `Basic ${Buffer.from(options.requireAuth).toString('base64')}`
    ) {
      res.writeHead(401, { 'www-authenticate': 'Basic realm="git"' });
      res.end();
      return;
    }

    const url = new URL(req.url ?? '/', 'http://localhost');
    const cgi = spawn('git', ['http-backend'], {
      env: {
        ...process.env,
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: '1',
        PATH_INFO: url.pathname,
        QUERY_STRING: url.search.slice(1),
        REQUEST_METHOD: req.method ?? 'GET',
        CONTENT_TYPE: req.headers['content-type'] ?? '',
        REMOTE_USER: 'tester',
        REMOTE_ADDR: '127.0.0.1',
      },
    });

    req.pipe(cgi.stdin);

    const chunks: Buffer[] = [];
    cgi.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    cgi.on('close', () => {
      const output = Buffer.concat(chunks);
      const split = output.indexOf('\r\n\r\n');
      const head = output.subarray(0, split).toString();
      const body = output.subarray(split + 4);

      let status = 200;
      const headers: Record<string, string> = {};
      for (const line of head.split('\r\n')) {
        const colon = line.indexOf(':');
        const name = line.slice(0, colon).trim();
        const value = line.slice(colon + 1).trim();
        if (name.toLowerCase() === 'status') status = Number(value.split(' ')[0]);
        else headers[name] = value;
      }
      res.writeHead(status, headers);
      res.end(body);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;

  return {
    url: (repository) => `http://127.0.0.1:${port}/${repository}`,
    create(repository) {
      execFileSync('git', ['init', '--bare', '--initial-branch=main', join(root, repository)], {
        stdio: 'ignore',
      });
      execFileSync('git', ['-C', join(root, repository), 'config', 'http.receivepack', 'true']);
    },
    git: (repository, ...args) =>
      execFileSync('git', ['-C', join(root, repository), ...args])
        .toString()
        .trim(),
    authorizations,
    close: () =>
      new Promise<void>((resolve) =>
        server.close(() => {
          rmSync(root, { recursive: true, force: true });
          resolve();
        }),
      ),
  };
}
