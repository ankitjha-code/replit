import { z } from 'zod';

export interface DotenvEntry {
  key: string;
  value: string;
  line: number;
}

export interface DotenvProblem {
  line: number;
  reason: string;
}

export interface ParsedDotenv {
  entries: DotenvEntry[];
  problems: DotenvProblem[];
}

const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/;

export function parseDotenv(text: string): ParsedDotenv {
  const byKey = new Map<string, DotenvEntry>();
  const problems: DotenvProblem[] = [];

  const lines = text.replace(/\r\n?/g, '\n').split('\n');

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index] ?? '';
    const lineNumber = index + 1;
    const trimmed = raw.trim();

    if (trimmed === '' || trimmed.startsWith('#')) continue;

    const match = LINE.exec(raw);
    if (!match) {
      problems.push({ line: lineNumber, reason: 'Not a KEY=value line' });
      continue;
    }

    const key = match[1]!;
    const rest = match[2] ?? '';
    const value = readValue(rest);

    if (value === undefined) {
      problems.push({ line: lineNumber, reason: `The quote around ${key} is never closed` });
      continue;
    }

    if (byKey.has(key)) {
      problems.push({
        line: lineNumber,
        reason: `${key} appears more than once; the later line is the one that counts`,
      });
    }

    byKey.set(key, { key, value, line: lineNumber });
  }

  return { entries: [...byKey.values()], problems };
}

function readValue(rest: string): string | undefined {
  const value = rest.trim();

  if (value.startsWith('"')) {
    let out = '';
    for (let position = 1; position < value.length; position += 1) {
      const character = value[position]!;
      if (character === '\\' && position + 1 < value.length) {
        const next = value[position + 1]!;
        out += next === 'n' ? '\n' : next === 't' ? '\t' : next === 'r' ? '\r' : next;
        position += 1;
        continue;
      }
      if (character === '"') return out;
      out += character;
    }
    return undefined;
  }

  if (value.startsWith("'")) {
    const end = value.indexOf("'", 1);
    return end === -1 ? undefined : value.slice(1, end);
  }

  const comment = value.search(/\s#/);
  return (comment === -1 ? value : value.slice(0, comment)).trim();
}

export const MAX_DOTENV_BYTES = 64 * 1024;

export const importEnvironmentRequestSchema = z.object({
  text: z.string().min(1, 'Paste the contents of a .env file').max(MAX_DOTENV_BYTES),
  as: z.enum(['variables', 'secrets']),
});

export type ImportEnvironmentRequest = z.infer<typeof importEnvironmentRequestSchema>;

export const importEnvironmentResponseSchema = z.object({
  applied: z.array(z.string()),
  refused: z.array(z.object({ key: z.string().nullable(), line: z.number(), reason: z.string() })),
});

export type ImportEnvironmentResponse = z.infer<typeof importEnvironmentResponseSchema>;
