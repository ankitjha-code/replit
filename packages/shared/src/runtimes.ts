import { z } from 'zod';
import { RUNTIME_STATUSES } from './lifecycle.js';

export const RUNTIME_LANGUAGES = ['node', 'python', 'go', 'ruby', 'static'] as const;

export type RuntimeLanguage = (typeof RUNTIME_LANGUAGES)[number];

export interface RuntimeDefinition {
  language: RuntimeLanguage;
  displayName: string;
  image: string;
  version: string;
  manifests: readonly string[];
  extensions: readonly string[];
}

export const RUNTIME_DEFINITIONS: Readonly<Record<RuntimeLanguage, RuntimeDefinition>> = {
  node: {
    language: 'node',
    displayName: 'Node.js',
    image: 'node:22-bookworm-slim',
    version: '22',
    manifests: ['package.json'],
    extensions: ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx'],
  },
  python: {
    language: 'python',
    displayName: 'Python',
    image: 'python:3.12-slim-bookworm',
    version: '3.12',
    manifests: ['requirements.txt', 'pyproject.toml', 'Pipfile'],
    extensions: ['.py'],
  },
  go: {
    language: 'go',
    displayName: 'Go',
    image: 'golang:1.23-bookworm',
    version: '1.23',
    manifests: ['go.mod'],
    extensions: ['.go'],
  },
  ruby: {
    language: 'ruby',
    displayName: 'Ruby',
    image: 'ruby:3.3-slim-bookworm',
    version: '3.3',
    manifests: ['Gemfile'],
    extensions: ['.rb'],
  },
  static: {
    language: 'static',
    displayName: 'Static site',
    image: 'busybox:1.36',
    version: '1.36',
    manifests: ['index.html'],
    extensions: ['.html'],
  },
};

export function isRuntimeLanguage(value: string): value is RuntimeLanguage {
  return (RUNTIME_LANGUAGES as readonly string[]).includes(value);
}

export interface ResourceLimits {
  cpuMillicores: number;
  memoryMb: number;
  pidsLimit: number;
}

export const resourceLimitsSchema = z.object({
  cpuMillicores: z.number().int().min(100).max(8_000),
  memoryMb: z.number().int().min(128).max(16_384),
  pidsLimit: z.number().int().min(16).max(4_096),
});

export const DEFAULT_RESOURCE_LIMITS: ResourceLimits = {
  cpuMillicores: 1_000,
  memoryMb: 1_024,
  pidsLimit: 256,
};

export interface RuntimeDetection {
  language: RuntimeLanguage;
  version: string;
  image: string;
  evidence: string;
}

const LANGUAGE_ORDER = RUNTIME_LANGUAGES;

export function detectRuntime(paths: readonly string[]): RuntimeDetection | null {
  const roots = new Set(paths.filter((path) => !path.includes('/')));

  for (const language of LANGUAGE_ORDER) {
    const definition = RUNTIME_DEFINITIONS[language];
    const manifest = definition.manifests.find((name) => roots.has(name));
    if (manifest) return detection(definition, manifest);
  }

  const counts = new Map<RuntimeLanguage, { count: number; first: string }>();

  for (const path of paths) {
    const language = languageForExtension(path);
    if (!language) continue;
    const existing = counts.get(language);
    if (existing) existing.count += 1;
    else counts.set(language, { count: 1, first: path });
  }

  let winner: { language: RuntimeLanguage; count: number; first: string } | undefined;
  for (const language of LANGUAGE_ORDER) {
    const entry = counts.get(language);
    if (entry && (!winner || entry.count > winner.count)) {
      winner = { language, count: entry.count, first: entry.first };
    }
  }

  if (!winner) return null;
  return detection(RUNTIME_DEFINITIONS[winner.language], winner.first);
}

function detection(definition: RuntimeDefinition, evidence: string): RuntimeDetection {
  return {
    language: definition.language,
    version: definition.version,
    image: definition.image,
    evidence,
  };
}

function languageForExtension(path: string): RuntimeLanguage | undefined {
  const dot = path.lastIndexOf('.');
  if (dot <= 0) return undefined;
  const extension = path.slice(dot).toLowerCase();

  for (const language of LANGUAGE_ORDER) {
    if (RUNTIME_DEFINITIONS[language].extensions.includes(extension)) return language;
  }
  return undefined;
}

export const RUNTIME_TRANSITIONAL_STATUSES = [
  'REQUESTED',
  'CREATING',
  'STARTING',
  'STOPPING',
] as const;

export function isRuntimeTransitional(status: string): boolean {
  return (RUNTIME_TRANSITIONAL_STATUSES as readonly string[]).includes(status);
}

export const runtimeSummarySchema = z.object({
  id: z.string(),
  projectId: z.string(),
  status: z.enum(RUNTIME_STATUSES),
  language: z.enum(RUNTIME_LANGUAGES),
  version: z.string(),
  image: z.string(),
  limits: resourceLimitsSchema,
  message: z.string().nullable(),
  createdAt: z.string(),
  statusChangedAt: z.string(),
  startedAt: z.string().nullable(),
  stoppedAt: z.string().nullable(),
});

export type RuntimeSummary = z.infer<typeof runtimeSummarySchema>;

export const runtimeDetectionSchema = z.object({
  language: z.enum(RUNTIME_LANGUAGES),
  version: z.string(),
  image: z.string(),
  evidence: z.string(),
});

export const runtimeStateResponseSchema = z.object({
  runtime: runtimeSummarySchema.nullable(),
  detected: runtimeDetectionSchema.nullable(),
  provider: z.object({
    name: z.string(),
    available: z.boolean(),
    reason: z.string().nullable(),
  }),
});

export type RuntimeStateResponse = z.infer<typeof runtimeStateResponseSchema>;

export const runtimeEventSchema = z.object({
  id: z.string(),
  from: z.enum(RUNTIME_STATUSES).nullable(),
  to: z.enum(RUNTIME_STATUSES),
  reason: z.string().nullable(),
  at: z.string(),
});

export type RuntimeEventSummary = z.infer<typeof runtimeEventSchema>;

export const runtimeHistoryResponseSchema = z.object({
  events: z.array(runtimeEventSchema),
});

export type RuntimeHistoryResponse = z.infer<typeof runtimeHistoryResponseSchema>;

export const startRuntimeRequestSchema = z
  .object({
    language: z.enum(RUNTIME_LANGUAGES).optional(),
  })
  .default({});

export type StartRuntimeRequest = z.infer<typeof startRuntimeRequestSchema>;
