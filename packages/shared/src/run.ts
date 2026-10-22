import { z } from 'zod';
import { RUNTIME_DEFINITIONS, type RuntimeLanguage } from './runtimes.js';

export const RUN_STATUSES = ['IDLE', 'STARTING', 'RUNNING', 'EXITED', 'FAILED'] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];

export const MAX_RUN_COMMAND_LENGTH = 2_000;

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code === 0x09 || code === 0x0a) continue;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

export const runCommandSchema = z
  .string()
  .trim()
  .min(1, 'Give the project something to run')
  .max(MAX_RUN_COMMAND_LENGTH)
  .refine((command) => !hasControlCharacters(command), {
    message: 'A command cannot contain control characters',
  });

export const setRunCommandRequestSchema = z.object({
  command: runCommandSchema.nullable(),
});

export type SetRunCommandRequest = z.infer<typeof setRunCommandRequestSchema>;

export interface RunSuggestion {
  command: string;
  reason: string;
}

export interface RunContext {
  paths: readonly string[];
  packageScripts?: Readonly<Record<string, string>> | undefined;
  packageMain?: string | undefined;
}

export const STATIC_PREVIEW_PORT = 8080;

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
      return {
        command: `httpd -f -p ${STATIC_PREVIEW_PORT} -h .`,
        reason: `the ${RUNTIME_DEFINITIONS.static.displayName.toLowerCase()} runtime`,
      };
    }
  }
}

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

export const runStateSchema = z.object({
  status: z.enum(RUN_STATUSES),
  command: z.string().nullable(),
  configuredCommand: z.string().nullable(),
  suggestion: z.object({ command: z.string(), reason: z.string() }).nullable(),
  startedAt: z.string().nullable(),
  exitedAt: z.string().nullable(),
  exitCode: z.number().int().nullable(),
  message: z.string().nullable(),
  blockedReason: z.string().nullable(),
});

export type RunState = z.infer<typeof runStateSchema>;

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

export const outputMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('history'),
    lines: z.array(z.object({ stream: z.enum(OUTPUT_STREAMS), data: z.string(), at: z.string() })),
    truncated: z.boolean(),
  }),
  z.object({ type: z.literal('output'), stream: z.enum(OUTPUT_STREAMS), data: z.string() }),
  z.object({
    type: z.literal('status'),
    status: z.enum(RUN_STATUSES),
    exitCode: z.number().int().nullable(),
  }),
  z.object({ type: z.literal('error'), message: z.string() }),
]);

export type OutputMessage = z.infer<typeof outputMessageSchema>;
