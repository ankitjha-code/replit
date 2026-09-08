import { z } from 'zod';
import { RUNTIME_STATUSES } from './lifecycle.js';

/**
 * What a project needs in order to run, and what the control plane and the
 * execution plane agree about.
 *
 * The status values and their transitions live in `lifecycle.ts`, because a
 * deployment obeys the same shape of rules. This module is about the runtime's
 * identity: which language, which image, how much of the machine it may have,
 * and how the platform works out which of those a project wants.
 *
 * Nothing here starts anything. Choosing a runtime is a decision the control
 * plane makes and records; carrying it out belongs to an execution provider.
 */

/**
 * Languages the platform can identify and intends to run.
 *
 * Ordered by precedence: when a project shows evidence of more than one, the
 * earlier entry wins. `static` is last on purpose, because a page of HTML sits
 * inside most projects of every other kind.
 */
export const RUNTIME_LANGUAGES = ['node', 'python', 'go', 'ruby', 'static'] as const;

export type RuntimeLanguage = (typeof RUNTIME_LANGUAGES)[number];

export interface RuntimeDefinition {
  language: RuntimeLanguage;
  /** Shown to a person. */
  displayName: string;
  /**
   * The base image an execution provider starts for this language.
   *
   * A tag rather than a digest today. Pinning by digest is what makes a
   * rebuild reproducible, and belongs with the code that actually pulls the
   * image.
   */
  image: string;
  /** The version that image provides, shown alongside the runtime. */
  version: string;
  /**
   * File names at the project root that identify this runtime outright. A
   * manifest is deliberate: someone put it there to declare what the project
   * is.
   */
  manifests: readonly string[];
  /**
   * Extensions consulted only when no manifest matched anywhere. Weaker
   * evidence, so it decides nothing while a manifest is present.
   */
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
    /*
     * BusyBox rather than a web server image, and for a reason worth knowing.
     *
     * Runtime containers drop every Linux capability. A binary that carries
     * file capabilities cannot be executed at all in that state: the kernel
     * refuses rather than running it with fewer privileges. Caddy and nginx
     * both ship with `cap_net_bind_service` set on their binaries, so neither
     * runs here. BusyBox does, its `httpd` applet serves a directory, and the
     * hardening is not worth weakening for the convenience of one image.
     */
    image: 'busybox:1.36',
    version: '1.36',
    manifests: ['index.html'],
    extensions: ['.html'],
  },
};

/**
 * Whether a stored value still names a runtime the platform knows.
 *
 * A runtime row keeps the language it was created with, and the catalogue can
 * change underneath it. Reading one back is therefore a question, not an
 * assumption.
 */
export function isRuntimeLanguage(value: string): value is RuntimeLanguage {
  return (RUNTIME_LANGUAGES as readonly string[]).includes(value);
}

/**
 * How much of the host one runtime may take.
 *
 * Every provider must enforce these. A development environment with no ceiling
 * is a way for one project to take the machine away from every other project
 * on it, which is the failure mode a shared platform exists to prevent.
 */
export interface ResourceLimits {
  /** Thousandths of one CPU core. 1000 is one core. */
  cpuMillicores: number;
  memoryMb: number;
  /**
   * Maximum processes. A fork bomb costs neither CPU quota nor memory quota
   * to write, so neither of the limits above stops one.
   */
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

/**
 * Which runtime a project wants, and the file that says so.
 *
 * The evidence is carried because a person shown "Python" should be able to
 * find out why. A detection that cannot explain itself is indistinguishable
 * from a guess.
 */
export interface RuntimeDetection {
  language: RuntimeLanguage;
  version: string;
  image: string;
  evidence: string;
}

const LANGUAGE_ORDER = RUNTIME_LANGUAGES;

/**
 * Works out which runtime a project needs from the paths it contains.
 *
 * Deliberate declarations beat inference: a manifest at the root decides on
 * its own, and file extensions are consulted only when no manifest exists
 * anywhere. Returns null rather than guessing when a project shows no evidence
 * at all, because starting the wrong runtime wastes someone's time more
 * expensively than asking them.
 */
export function detectRuntime(paths: readonly string[]): RuntimeDetection | null {
  const roots = new Set(paths.filter((path) => !path.includes('/')));

  for (const language of LANGUAGE_ORDER) {
    const definition = RUNTIME_DEFINITIONS[language];
    const manifest = definition.manifests.find((name) => roots.has(name));
    if (manifest) return detection(definition, manifest);
  }

  // No declaration anywhere. Fall back to what the files themselves are, and
  // let the language with the most files win so one stray script does not
  // decide for a project written in something else.
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
    // Strictly greater, so a tie is broken by the precedence order above
    // rather than by the order files happened to arrive in.
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

/**
 * States that are on their way somewhere.
 *
 * A caller seeing one of these should expect the state to change without
 * anyone asking it to, and should not offer an action that assumes otherwise.
 */
export const RUNTIME_TRANSITIONAL_STATUSES = [
  'REQUESTED',
  'CREATING',
  'STARTING',
  'STOPPING',
] as const;

export function isRuntimeTransitional(status: string): boolean {
  return (RUNTIME_TRANSITIONAL_STATUSES as readonly string[]).includes(status);
}

// ---------------------------------------------------------------------------
// Wire contracts
// ---------------------------------------------------------------------------

export const runtimeSummarySchema = z.object({
  id: z.string(),
  projectId: z.string(),
  status: z.enum(RUNTIME_STATUSES),
  language: z.enum(RUNTIME_LANGUAGES),
  version: z.string(),
  image: z.string(),
  limits: resourceLimitsSchema,
  /**
   * Why the runtime is in this state, when that is not obvious. Carries the
   * reason a start failed. Written to be safe to show: provider detail belongs
   * in the logs.
   */
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

/**
 * Everything the workspace needs to describe running to a person.
 *
 * The provider block is part of the contract rather than an afterthought: a
 * client must be able to tell "this project has never been started" from
 * "this installation cannot start anything", and say which.
 */
export const runtimeStateResponseSchema = z.object({
  /** Null when this project has never had a runtime. */
  runtime: runtimeSummarySchema.nullable(),
  /** Null when the project contains no evidence of any known runtime. */
  detected: runtimeDetectionSchema.nullable(),
  provider: z.object({
    name: z.string(),
    available: z.boolean(),
    /** Why it is unavailable, in words a person can act on. Null when it is. */
    reason: z.string().nullable(),
  }),
});

export type RuntimeStateResponse = z.infer<typeof runtimeStateResponseSchema>;

/**
 * One recorded change of runtime state.
 *
 * Who caused it is deliberately not published: the workspace shows what
 * happened to the project, and naming the person adds nothing a collaborator
 * needs while telling them when someone else was working.
 */
export const runtimeEventSchema = z.object({
  id: z.string(),
  /** Null for the first event, when the runtime had no previous state. */
  from: z.enum(RUNTIME_STATUSES).nullable(),
  to: z.enum(RUNTIME_STATUSES),
  reason: z.string().nullable(),
  at: z.string(),
});

export type RuntimeEventSummary = z.infer<typeof runtimeEventSchema>;

export const runtimeHistoryResponseSchema = z.object({
  /** Most recent first. */
  events: z.array(runtimeEventSchema),
});

export type RuntimeHistoryResponse = z.infer<typeof runtimeHistoryResponseSchema>;

/**
 * Defaulted rather than required, so starting a project needs no body at all.
 * The ordinary request is "start this", and asking a caller to send an empty
 * object to say so is ceremony.
 */
export const startRuntimeRequestSchema = z
  .object({
    /** Overrides detection when someone knows better than the file listing. */
    language: z.enum(RUNTIME_LANGUAGES).optional(),
  })
  .default({});

export type StartRuntimeRequest = z.infer<typeof startRuntimeRequestSchema>;
