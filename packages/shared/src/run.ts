import { z } from 'zod';
import { RUNTIME_DEFINITIONS, type RuntimeLanguage } from './runtimes.js';

/**
 * Running a project's own application.
 *
 * A runtime is an environment; this is the program inside it. The two are
 * deliberately separate: a container that idles can still be opened as a
 * terminal, read back, and inspected when the application inside it has
 * crashed, which is exactly when someone needs all three.
 */

export const RUN_STATUSES = [
  /** Nothing has been started. */
  'IDLE',
  'STARTING',
  'RUNNING',
  /** The program ended. Normal for a script; a failure for a server. */
  'EXITED',
  /** The platform could not start it, or could not keep track of it. */
  'FAILED',
] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];

/**
 * Longest command the platform will run.
 *
 * Generous for a real command line, bounded because it is stored, shown, and
 * passed to a shell inside the container.
 */
export const MAX_RUN_COMMAND_LENGTH = 2_000;

/**
 * Whether a string contains a character that cannot be typed deliberately.
 *
 * Tab and newline are allowed: a long command is sometimes written across
 * lines. Everything else below a space, and delete, is refused, because all
 * of them can hide what a command really does from the person reading it.
 *
 * Written as a scan rather than a pattern so the boundaries are visible.
 */
function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code === 0x09 || code === 0x0a) continue;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * What a run command may contain.
 *
 * A shell command, so almost everything is allowed: pipes, redirection and
 * `&&` are how people actually start things.
 */
export const runCommandSchema = z
  .string()
  .trim()
  .min(1, 'Give the project something to run')
  .max(MAX_RUN_COMMAND_LENGTH)
  .refine((command) => !hasControlCharacters(command), {
    message: 'A command cannot contain control characters',
  });

export const setRunCommandRequestSchema = z.object({
  /** Null clears it, which puts the project back on the suggestion. */
  command: runCommandSchema.nullable(),
});

export type SetRunCommandRequest = z.infer<typeof setRunCommandRequestSchema>;

/**
 * A command the platform believes would start this project, and why.
 *
 * The reason is carried for the same reason runtime detection carries its
 * evidence: a suggestion someone cannot check is indistinguishable from a
 * guess, and this one is about to run.
 */
export interface RunSuggestion {
  command: string;
  reason: string;
}

export interface RunContext {
  /** Every file path in the project. */
  paths: readonly string[];
  /** The `scripts` block of a package.json at the root, when there is one. */
  packageScripts?: Readonly<Record<string, string>> | undefined;
  /** The `main` field of that package.json. */
  packageMain?: string | undefined;
}

/** Where a static site is served from, and on which port. */
export const STATIC_PREVIEW_PORT = 8080;

/**
 * Works out how to start a project.
 *
 * Declarations win over conventions, exactly as in runtime detection: a start
 * script someone wrote beats a filename the platform recognises. Returns
 * nothing rather than guessing when a project offers neither, because running
 * the wrong thing is worse than being asked.
 */
export function suggestRunCommand(
  language: RuntimeLanguage,
  context: RunContext,
): RunSuggestion | undefined {
  const has = (path: string): boolean => context.paths.includes(path);

  switch (language) {
    case 'node': {
      if (context.packageScripts?.start) {
        return { command: 'npm start', reason: 'the start script in package.json' };
      }
      if (context.packageMain && has(context.packageMain)) {
        return { command: `node ${context.packageMain}`, reason: 'the main file in package.json' };
      }
      for (const entry of ['index.js', 'server.js', 'app.js', 'main.js', 'src/index.js']) {
        if (has(entry)) return { command: `node ${entry}`, reason: entry };
      }
      return undefined;
    }

    case 'python': {
      for (const entry of ['main.py', 'app.py', 'server.py', '__main__.py']) {
        if (has(entry)) return { command: `python ${entry}`, reason: entry };
      }
      return undefined;
    }

    case 'go': {
      if (has('go.mod')) return { command: 'go run .', reason: 'go.mod' };
      return undefined;
    }

    case 'ruby': {
      for (const entry of ['main.rb', 'app.rb', 'server.rb', 'config.ru']) {
        if (has(entry)) {
          return entry === 'config.ru'
            ? { command: 'rackup --host 0.0.0.0 --port 8080', reason: 'config.ru' }
            : { command: `ruby ${entry}`, reason: entry };
        }
      }
      return undefined;
    }

    case 'static': {
      // The image's own web server, serving the workspace. Nothing to detect:
      // a static site is the one runtime whose command never varies.
      return {
        command: `httpd -f -p ${STATIC_PREVIEW_PORT} -h .`,
        reason: `the ${RUNTIME_DEFINITIONS.static.displayName.toLowerCase()} runtime`,
      };
    }
  }
}

/**
 * Reads the parts of a package.json that decide how a project starts.
 *
 * Tolerant of anything: this file comes from the project, so it may be
 * malformed, may not be an object, and may have a `scripts` that is a string.
 * None of that should stop the platform answering.
 */
export function readPackageJson(text: string): Pick<RunContext, 'packageScripts' | 'packageMain'> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {};
  }

  if (typeof parsed !== 'object' || parsed === null) return {};
  const record = parsed as Record<string, unknown>;

  const scripts =
    typeof record.scripts === 'object' && record.scripts !== null
      ? Object.fromEntries(
          Object.entries(record.scripts as Record<string, unknown>).filter(
            (entry): entry is [string, string] => typeof entry[1] === 'string',
          ),
        )
      : undefined;

  return {
    ...(scripts ? { packageScripts: scripts } : {}),
    ...(typeof record.main === 'string' ? { packageMain: record.main } : {}),
  };
}

// ---------------------------------------------------------------------------
// Wire contracts
// ---------------------------------------------------------------------------

export const runStateSchema = z.object({
  status: z.enum(RUN_STATUSES),
  /** What is running, or last ran. Null when nothing ever has. */
  command: z.string().nullable(),
  /** What the project has configured, if anything. Null means use the suggestion. */
  configuredCommand: z.string().nullable(),
  /** What the platform would run, and why. Null when it cannot tell. */
  suggestion: z.object({ command: z.string(), reason: z.string() }).nullable(),
  startedAt: z.string().nullable(),
  exitedAt: z.string().nullable(),
  /** Null when the program is running, or when the platform could not learn it. */
  exitCode: z.number().int().nullable(),
  /** Why it is in this state, when that needs saying. Safe to show. */
  message: z.string().nullable(),
  /** Why it cannot be started right now. Null when it can. */
  blockedReason: z.string().nullable(),
});

export type RunState = z.infer<typeof runStateSchema>;

// ---------------------------------------------------------------------------
// Output protocol
// ---------------------------------------------------------------------------

/** The address of a project's application output. */
export function outputPath(projectId: string): string {
  return `/ws/projects/${encodeURIComponent(projectId)}/output`;
}

export function projectIdFromOutputPath(pathname: string): string | undefined {
  const match = /^\/ws\/projects\/([^/]+)\/output$/.exec(pathname);
  if (!match?.[1]) return undefined;
  return decodeURIComponent(match[1]);
}

export const OUTPUT_STREAMS = ['stdout', 'stderr'] as const;
export type OutputStream = (typeof OUTPUT_STREAMS)[number];

/**
 * What the server sends on an output socket.
 *
 * One direction only. A client that could write here would be a second way to
 * reach the process, and there is already a terminal for that.
 */
export const outputMessageSchema = z.discriminatedUnion('type', [
  /** Everything buffered before this client connected, in order. */
  z.object({
    type: z.literal('history'),
    lines: z.array(z.object({ stream: z.enum(OUTPUT_STREAMS), data: z.string(), at: z.string() })),
    /** True when output older than this was dropped from the buffer. */
    truncated: z.boolean(),
  }),
  z.object({ type: z.literal('output'), stream: z.enum(OUTPUT_STREAMS), data: z.string() }),
  /** The run state changed. The client refreshes what it shows. */
  z.object({
    type: z.literal('status'),
    status: z.enum(RUN_STATUSES),
    exitCode: z.number().int().nullable(),
  }),
  z.object({ type: z.literal('error'), message: z.string() }),
]);

export type OutputMessage = z.infer<typeof outputMessageSchema>;
