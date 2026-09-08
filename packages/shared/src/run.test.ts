import { describe, expect, it } from 'vitest';
import {
  outputMessageSchema,
  outputPath,
  projectIdFromOutputPath,
  readPackageJson,
  runCommandSchema,
  runStateSchema,
  suggestRunCommand,
} from './run.js';

/**
 * Running a project's own application.
 *
 * The suggestion is the interesting part: it decides what a person's project
 * does when they press Run, so it has to prefer what they declared over what
 * the platform recognises, and say nothing at all rather than guess.
 */

// Written as escapes rather than as literals: a control character in source is
// invisible, and the next person to touch this file would not know it is there.
const bell = String.fromCharCode(0x07);
const escape = String.fromCharCode(0x1b);
const nul = String.fromCharCode(0x00);

describe('what a command may be', () => {
  it('accepts the shell a person would actually type', () => {
    for (const command of [
      'npm start',
      'node server.js --port 3000',
      'python -m http.server 8000',
      'npm run build && node dist/main.js',
      'FOO=bar ./run.sh | tee log.txt',
    ]) {
      expect(runCommandSchema.safeParse(command).success).toBe(true);
    }
  });

  it('refuses an empty command', () => {
    expect(runCommandSchema.safeParse('').success).toBe(false);
    expect(runCommandSchema.safeParse('   ').success).toBe(false);
  });

  it('refuses characters nobody types on purpose', () => {
    // A command carrying an escape sequence reads as one thing and does
    // another when it is shown back.
    for (const command of [`npm start ${bell}`, `node ${escape}[2Kx.js`, `run${nul}`]) {
      expect(runCommandSchema.safeParse(command).success).toBe(false);
    }
  });

  it('allows a command written across lines', () => {
    expect(runCommandSchema.safeParse('npm run build &&\n  node dist/main.js').success).toBe(true);
  });

  it('refuses one longer than any real command line', () => {
    expect(runCommandSchema.safeParse('node '.repeat(1000)).success).toBe(false);
  });
});

describe('suggesting how to start a Node project', () => {
  it('prefers the start script somebody wrote', () => {
    const suggestion = suggestRunCommand('node', {
      paths: ['package.json', 'index.js'],
      packageScripts: { start: 'node server.js', test: 'vitest' },
    });

    expect(suggestion?.command).toBe('npm start');
    expect(suggestion?.reason).toContain('package.json');
  });

  it('falls back to the main file the manifest names', () => {
    const suggestion = suggestRunCommand('node', {
      paths: ['package.json', 'server.js'],
      packageMain: 'server.js',
    });

    expect(suggestion?.command).toBe('node server.js');
  });

  it('ignores a main file that is not there', () => {
    // A manifest can name a file that was deleted or never written.
    const suggestion = suggestRunCommand('node', {
      paths: ['package.json', 'index.js'],
      packageMain: 'gone.js',
    });

    expect(suggestion?.command).toBe('node index.js');
  });

  it('falls back to the conventional entry points, in order', () => {
    expect(suggestRunCommand('node', { paths: ['server.js', 'app.js'] })?.command).toBe(
      'node server.js',
    );
    expect(suggestRunCommand('node', { paths: ['app.js'] })?.command).toBe('node app.js');
  });

  it('says nothing when the project offers nothing to go on', () => {
    // Running the wrong thing is worse than being asked.
    expect(suggestRunCommand('node', { paths: ['package.json', 'README.md'] })).toBeUndefined();
  });
});

describe('suggesting how to start other runtimes', () => {
  it('finds a Python entry point', () => {
    expect(suggestRunCommand('python', { paths: ['main.py'] })?.command).toBe('python main.py');
    expect(suggestRunCommand('python', { paths: ['app.py'] })?.command).toBe('python app.py');
  });

  it('runs a Go module from its root', () => {
    expect(suggestRunCommand('go', { paths: ['go.mod', 'main.go'] })?.command).toBe('go run .');
  });

  it('prefers a Ruby entry point, and knows a rack app is different', () => {
    expect(suggestRunCommand('ruby', { paths: ['main.rb'] })?.command).toBe('ruby main.rb');
    expect(suggestRunCommand('ruby', { paths: ['config.ru'] })?.command).toContain('rackup');
  });

  it('always knows how to serve a static site', () => {
    // The one runtime whose command never varies, so it never needs asking.
    const suggestion = suggestRunCommand('static', { paths: ['index.html'] });
    expect(suggestion?.command).toContain('httpd');
    expect(suggestion?.command).toContain('8080');
  });

  it('says nothing for a language with no entry point present', () => {
    expect(suggestRunCommand('python', { paths: ['lib/util.py'] })).toBeUndefined();
    expect(suggestRunCommand('go', { paths: ['main.go'] })).toBeUndefined();
    expect(suggestRunCommand('ruby', { paths: ['lib/thing.rb'] })).toBeUndefined();
  });
});

describe('reading a manifest that came from a project', () => {
  it('reads the parts that matter', () => {
    const read = readPackageJson('{"main":"server.js","scripts":{"start":"node server.js"}}');
    expect(read.packageMain).toBe('server.js');
    expect(read.packageScripts?.start).toBe('node server.js');
  });

  it('survives anything, because this file came from the project', () => {
    // Malformed, not an object, wrong types inside: none of it should stop the
    // platform answering.
    expect(readPackageJson('not json')).toEqual({});
    expect(readPackageJson('[1,2,3]')).toEqual({});
    expect(readPackageJson('"a string"')).toEqual({});
    expect(readPackageJson('{"scripts":"nope","main":42}')).toEqual({});
  });

  it('drops script entries that are not commands', () => {
    const read = readPackageJson('{"scripts":{"start":"node x.js","weird":{"nested":true}}}');
    expect(read.packageScripts).toEqual({ start: 'node x.js' });
  });
});

describe('the run state', () => {
  it('can say that nothing has run and nothing can be suggested', () => {
    const parsed = runStateSchema.parse({
      status: 'IDLE',
      command: null,
      configuredCommand: null,
      suggestion: null,
      startedAt: null,
      exitedAt: null,
      exitCode: null,
      message: null,
      blockedReason: 'Start the project before running it.',
    });

    expect(parsed.status).toBe('IDLE');
    expect(parsed.blockedReason).not.toBeNull();
  });

  it('carries an exit code, which may be unknown', () => {
    const base = {
      status: 'EXITED' as const,
      command: 'npm start',
      configuredCommand: null,
      suggestion: null,
      startedAt: '2026-01-01T00:00:00.000Z',
      exitedAt: '2026-01-01T00:01:00.000Z',
      message: null,
      blockedReason: null,
    };

    expect(runStateSchema.safeParse({ ...base, exitCode: 1 }).success).toBe(true);
    expect(runStateSchema.safeParse({ ...base, exitCode: null }).success).toBe(true);
  });
});

describe('the output protocol', () => {
  it('round-trips a project identifier through its address', () => {
    const id = '018f0000-0000-7000-8000-0000000000aa';
    expect(projectIdFromOutputPath(outputPath(id))).toBe(id);
  });

  it('refuses anything that is not exactly this route', () => {
    for (const path of ['/ws/projects//output', '/ws/projects/a/terminal', '/output', '']) {
      expect(projectIdFromOutputPath(path)).toBeUndefined();
    }
  });

  it('carries history, live output, and a status change', () => {
    expect(
      outputMessageSchema.safeParse({
        type: 'history',
        lines: [{ stream: 'stdout', data: 'listening\n', at: '2026-01-01T00:00:00.000Z' }],
        truncated: true,
      }).success,
    ).toBe(true);

    expect(
      outputMessageSchema.safeParse({ type: 'output', stream: 'stderr', data: 'oh no\n' }).success,
    ).toBe(true);

    expect(
      outputMessageSchema.safeParse({ type: 'status', status: 'EXITED', exitCode: 1 }).success,
    ).toBe(true);
  });

  it('refuses a stream it does not know', () => {
    expect(
      outputMessageSchema.safeParse({ type: 'output', stream: 'stdin', data: 'x' }).success,
    ).toBe(false);
  });
});
