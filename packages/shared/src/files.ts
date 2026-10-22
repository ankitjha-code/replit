import { z } from 'zod';

export const PATH_MAX_LENGTH = 1024;
export const SEGMENT_MAX_LENGTH = 255;

export const ROOT_PATH = '';

export const FILE_TYPES = ['FILE', 'DIRECTORY'] as const;
export type ProjectFileType = (typeof FILE_TYPES)[number];

// eslint-disable-next-line no-control-regex
const FORBIDDEN_CHARACTERS = /[\u0000-\u001f\u007f<>:"\\|?*]/;

const RESERVED_BASENAMES = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
]);

export type PathProblem =
  | 'empty'
  | 'too-long'
  | 'absolute'
  | 'segment-empty'
  | 'segment-too-long'
  | 'traversal'
  | 'forbidden-character'
  | 'reserved-name'
  | 'trailing-space-or-dot';

export interface PathResult {
  ok: boolean;
  path?: string;
  problem?: PathProblem;
}

export function normalizePath(input: string): PathResult {
  if (typeof input !== 'string' || input.length === 0) return { ok: false, problem: 'empty' };

  if (input.startsWith('/')) return { ok: false, problem: 'absolute' };
  if (/^[a-zA-Z]:[\\/]/.test(input)) return { ok: false, problem: 'absolute' };

  const raw = input.replace(/\/+/g, '/').replace(/\/+$/, '');
  if (raw.length === 0) return { ok: false, problem: 'empty' };
  if (raw.length > PATH_MAX_LENGTH) return { ok: false, problem: 'too-long' };

  const segments = raw.split('/');

  for (const segment of segments) {
    if (segment.length === 0) return { ok: false, problem: 'segment-empty' };
    if (segment.length > SEGMENT_MAX_LENGTH) return { ok: false, problem: 'segment-too-long' };
    if (segment === '.' || segment === '..') return { ok: false, problem: 'traversal' };
    if (FORBIDDEN_CHARACTERS.test(segment)) return { ok: false, problem: 'forbidden-character' };

    if (/[ .]$/.test(segment) || /^ /.test(segment)) {
      return { ok: false, problem: 'trailing-space-or-dot' };
    }

    const base = segment.split('.')[0]?.toLowerCase() ?? '';
    if (RESERVED_BASENAMES.has(base)) return { ok: false, problem: 'reserved-name' };
  }

  return { ok: true, path: raw };
}

export const PATH_PROBLEM_MESSAGES: Readonly<Record<PathProblem, string>> = {
  empty: 'Enter a name',
  'too-long': `Paths must be at most ${PATH_MAX_LENGTH} characters`,
  absolute: 'Paths are relative to the project, so they cannot start with a separator',
  'segment-empty': 'Path parts cannot be empty',
  'segment-too-long': `Each part of a path must be at most ${SEGMENT_MAX_LENGTH} characters`,
  traversal: 'Paths cannot contain "." or ".." parts',
  'forbidden-character': 'Names cannot contain < > : " \\ | ? * or control characters',
  'reserved-name': 'That name is reserved by some operating systems',
  'trailing-space-or-dot': 'Names cannot start with a space or end with a space or dot',
};

export function parentOf(path: string): string {
  const index = path.lastIndexOf('/');
  return index === -1 ? ROOT_PATH : path.slice(0, index);
}

export function baseName(path: string): string {
  const index = path.lastIndexOf('/');
  return index === -1 ? path : path.slice(index + 1);
}

export function joinPath(directory: string, name: string): string {
  return directory === ROOT_PATH ? name : `${directory}/${name}`;
}

export function isInside(directory: string, path: string): boolean {
  if (directory === ROOT_PATH) return true;
  return path.startsWith(`${directory}/`);
}

interface FileKind {
  language: string;
  mime: string;
}

const KNOWN_EXTENSIONS: Readonly<Record<string, FileKind>> = {
  js: { language: 'javascript', mime: 'text/javascript' },
  mjs: { language: 'javascript', mime: 'text/javascript' },
  cjs: { language: 'javascript', mime: 'text/javascript' },
  jsx: { language: 'javascript', mime: 'text/javascript' },
  ts: { language: 'typescript', mime: 'text/typescript' },
  tsx: { language: 'typescript', mime: 'text/typescript' },
  json: { language: 'json', mime: 'application/json' },
  html: { language: 'html', mime: 'text/html' },
  htm: { language: 'html', mime: 'text/html' },
  css: { language: 'css', mime: 'text/css' },
  md: { language: 'markdown', mime: 'text/markdown' },
  py: { language: 'python', mime: 'text/x-python' },
  rb: { language: 'ruby', mime: 'text/x-ruby' },
  go: { language: 'go', mime: 'text/x-go' },
  rs: { language: 'rust', mime: 'text/rust' },
  java: { language: 'java', mime: 'text/x-java' },
  c: { language: 'c', mime: 'text/x-c' },
  h: { language: 'c', mime: 'text/x-c' },
  cpp: { language: 'cpp', mime: 'text/x-c++' },
  sh: { language: 'shell', mime: 'text/x-sh' },
  yml: { language: 'yaml', mime: 'text/yaml' },
  yaml: { language: 'yaml', mime: 'text/yaml' },
  toml: { language: 'toml', mime: 'text/toml' },
  sql: { language: 'sql', mime: 'text/x-sql' },
  xml: { language: 'xml', mime: 'text/xml' },
  svg: { language: 'xml', mime: 'image/svg+xml' },
  txt: { language: 'plaintext', mime: 'text/plain' },
  png: { language: 'plaintext', mime: 'image/png' },
  jpg: { language: 'plaintext', mime: 'image/jpeg' },
  jpeg: { language: 'plaintext', mime: 'image/jpeg' },
  gif: { language: 'plaintext', mime: 'image/gif' },
  webp: { language: 'plaintext', mime: 'image/webp' },
  ico: { language: 'plaintext', mime: 'image/x-icon' },
  pdf: { language: 'plaintext', mime: 'application/pdf' },
};

const KNOWN_FILENAMES: Readonly<Record<string, FileKind>> = {
  dockerfile: { language: 'dockerfile', mime: 'text/plain' },
  makefile: { language: 'makefile', mime: 'text/plain' },
  '.gitignore': { language: 'plaintext', mime: 'text/plain' },
  '.env': { language: 'plaintext', mime: 'text/plain' },
};

export function extensionOf(path: string): string {
  const name = baseName(path);
  const index = name.lastIndexOf('.');
  return index <= 0 ? '' : name.slice(index + 1).toLowerCase();
}

export function detectFileKind(path: string): FileKind {
  const name = baseName(path).toLowerCase();
  const byName = KNOWN_FILENAMES[name];
  if (byName) return byName;

  return KNOWN_EXTENSIONS[extensionOf(path)] ?? { language: 'plaintext', mime: 'text/plain' };
}

export function languageOf(path: string): string {
  return detectFileKind(path).language;
}

const pathSchema = z
  .string()
  .max(PATH_MAX_LENGTH)
  .superRefine((value, ctx) => {
    const result = normalizePath(value);
    if (!result.ok) {
      ctx.addIssue({
        code: 'custom',
        message: PATH_PROBLEM_MESSAGES[result.problem ?? 'empty'],
      });
    }
  });

export const fileEntrySchema = z.object({
  path: z.string(),
  name: z.string(),
  type: z.enum(FILE_TYPES),
  size: z.number().int().nonnegative(),
  isBinary: z.boolean(),
  version: z.number().int().positive(),
  updatedAt: z.string(),
});

export type FileEntry = z.infer<typeof fileEntrySchema>;

export const fileTreeResponseSchema = z.object({
  entries: z.array(fileEntrySchema),
  totalBytes: z.number().int().nonnegative(),
});

export type FileTreeResponse = z.infer<typeof fileTreeResponseSchema>;

export const fileContentResponseSchema = z.object({
  entry: fileEntrySchema,
  content: z.string(),
  encoding: z.enum(['utf8', 'base64']),
});

export type FileContentResponse = z.infer<typeof fileContentResponseSchema>;

export const writeFileRequestSchema = z.object({
  path: pathSchema,
  content: z.string(),
  encoding: z.enum(['utf8', 'base64']).default('utf8'),
  expectedVersion: z.number().int().positive().optional(),
});

export type WriteFileRequest = z.infer<typeof writeFileRequestSchema>;

export const createDirectoryRequestSchema = z.object({ path: pathSchema });
export type CreateDirectoryRequest = z.infer<typeof createDirectoryRequestSchema>;

export const movePathRequestSchema = z.object({ from: pathSchema, to: pathSchema });
export type MovePathRequest = z.infer<typeof movePathRequestSchema>;

export const searchResultSchema = z.object({
  path: z.string(),
  match: z.enum(['path', 'content']),
  line: z.string().optional(),
  lineNumber: z.number().int().positive().optional(),
});

export type SearchResult = z.infer<typeof searchResultSchema>;

export const searchResponseSchema = z.object({
  results: z.array(searchResultSchema),
  truncated: z.boolean(),
});

export type SearchResponse = z.infer<typeof searchResponseSchema>;
