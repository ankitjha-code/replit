import { z } from 'zod';

/**
 * Reading a `.env` file, the way people actually write them.
 *
 * Here rather than on the server alone so the browser can show exactly what an
 * import will do before anybody presses the button — and so the server, which
 * decides, reads the text the same way the preview did. Two parsers would
 * eventually disagree about a quote.
 *
 * The dialect is the common one, not any single library's:
 *
 *  - `KEY=value`, with optional `export ` in front;
 *  - `#` comments on their own line, and after an unquoted value when preceded
 *    by whitespace (`URL=http://x#frag` keeps its fragment);
 *  - double quotes, with `\n`, `\t`, `\"` and `\\` escapes;
 *  - single quotes, taken literally;
 *  - a later line for the same key wins, and says so.
 *
 * Nothing is expanded. `${OTHER}` stays as written, because an import that
 * resolved references would depend on the order it happened to read things in.
 */

export interface DotenvEntry {
  key: string;
  value: string;
  /** Where it came from, one-based, so a problem can point at a line. */
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

  // Unquoted: a comment starts only at whitespace followed by `#`, so a URL
  // fragment or a colour code survives.
  const comment = value.search(/\s#/);
  return (comment === -1 ? value : value.slice(0, comment)).trim();
}

// ---------------------------------------------------------------------------
// The import request and its answer
// ---------------------------------------------------------------------------

/** Enough for any real `.env`; a ceiling so a paste cannot be a denial of service. */
export const MAX_DOTENV_BYTES = 64 * 1024;

export const importEnvironmentRequestSchema = z.object({
  text: z.string().min(1, 'Paste the contents of a .env file').max(MAX_DOTENV_BYTES),
  /**
   * Where the values go.
   *
   * A real `.env` usually contains credentials, and importing those as plain
   * variables would put them where they are returned by an endpoint and shown on
   * a page. The choice is explicit so nobody does that by accident.
   */
  as: z.enum(['variables', 'secrets']),
});

export type ImportEnvironmentRequest = z.infer<typeof importEnvironmentRequestSchema>;

export const importEnvironmentResponseSchema = z.object({
  /** The names that were set. */
  applied: z.array(z.string()),
  /** The lines that were not, and why, in words a person can act on. */
  refused: z.array(z.object({ key: z.string().nullable(), line: z.number(), reason: z.string() })),
});

export type ImportEnvironmentResponse = z.infer<typeof importEnvironmentResponseSchema>;
