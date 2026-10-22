import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RESOURCE_LIMITS,
  RUNTIME_DEFINITIONS,
  RUNTIME_LANGUAGES,
  detectRuntime,
  isRuntimeTransitional,
  resourceLimitsSchema,
  runtimeStateResponseSchema,
} from './runtimes.js';

describe('the runtime catalogue', () => {
  it('defines every language it lists', () => {
    for (const language of RUNTIME_LANGUAGES) {
      const definition = RUNTIME_DEFINITIONS[language];
      expect(definition.language).toBe(language);
      expect(definition.image.length).toBeGreaterThan(0);
      expect(definition.version.length).toBeGreaterThan(0);
    }
  });

  it('pins every image to a version rather than to latest', () => {
    // `latest` means a rebuild silently changes what a project runs on.
    for (const language of RUNTIME_LANGUAGES) {
      const { image } = RUNTIME_DEFINITIONS[language];
      expect(image).toContain(':');
      expect(image.endsWith(':latest')).toBe(false);
    }
  });

  it('claims no extension for two languages at once', () => {
    const seen = new Set<string>();
    for (const language of RUNTIME_LANGUAGES) {
      for (const extension of RUNTIME_DEFINITIONS[language].extensions) {
        expect(seen.has(extension)).toBe(false);
        seen.add(extension);
      }
    }
  });
});

describe('detecting a runtime', () => {
  it('finds nothing in an empty project rather than guessing', () => {
    expect(detectRuntime([])).toBeNull();
  });

  it('finds nothing when no file resembles a known runtime', () => {
    expect(detectRuntime(['README.md', 'notes/todo.txt', 'LICENSE'])).toBeNull();
  });

  it('identifies a project by its manifest', () => {
    const detected = detectRuntime(['package.json', 'src/index.js']);
    expect(detected?.language).toBe('node');
    expect(detected?.evidence).toBe('package.json');
  });

  it('accepts any of a language several manifests', () => {
    expect(detectRuntime(['pyproject.toml'])?.language).toBe('python');
    expect(detectRuntime(['requirements.txt'])?.language).toBe('python');
    expect(detectRuntime(['Pipfile'])?.language).toBe('python');
  });

  it('reports the image and version the runtime will use', () => {
    const detected = detectRuntime(['go.mod']);
    expect(detected?.image).toBe(RUNTIME_DEFINITIONS.go.image);
    expect(detected?.version).toBe(RUNTIME_DEFINITIONS.go.version);
  });

  it('ignores a manifest that is not at the root', () => {
    // A package.json inside a vendored dependency does not make the project a
    // Node project.
    expect(detectRuntime(['vendor/thing/package.json', 'main.rb'])?.language).toBe('ruby');
  });

  it('prefers a manifest over the files around it', () => {
    // A Python project with a build script written in JavaScript is still a
    // Python project.
    const detected = detectRuntime(['requirements.txt', 'tools/build.js', 'tools/watch.js']);
    expect(detected?.language).toBe('python');
  });

  it('falls back to the files when nothing is declared', () => {
    const detected = detectRuntime(['app.py', 'lib/helpers.py']);
    expect(detected?.language).toBe('python');
    expect(detected?.evidence).toBe('app.py');
  });

  it('lets the commonest language win the fallback', () => {
    const detected = detectRuntime(['one.js', 'a.py', 'b.py', 'c.py']);
    expect(detected?.language).toBe('python');
  });

  it('breaks a tie by precedence rather than by file order', () => {
    // Same answer whichever way round the listing arrives, which is what makes
    // the choice reproducible.
    expect(detectRuntime(['a.py', 'b.js'])?.language).toBe('node');
    expect(detectRuntime(['b.js', 'a.py'])?.language).toBe('node');
  });

  it('treats a page of HTML as a static site only when nothing else fits', () => {
    expect(detectRuntime(['index.html', 'style.css'])?.language).toBe('static');
    // The same file inside a Node project decides nothing.
    expect(detectRuntime(['package.json', 'index.html'])?.language).toBe('node');
  });
});

describe('resource limits', () => {
  it('has a default every provider can honour', () => {
    expect(resourceLimitsSchema.parse(DEFAULT_RESOURCE_LIMITS)).toEqual(DEFAULT_RESOURCE_LIMITS);
  });

  it('refuses a runtime with no process ceiling', () => {
    // Neither a CPU share nor a memory cap stops a fork bomb.
    expect(
      resourceLimitsSchema.safeParse({ ...DEFAULT_RESOURCE_LIMITS, pidsLimit: 0 }).success,
    ).toBe(false);
  });

  it('refuses limits large enough to take the whole host', () => {
    expect(
      resourceLimitsSchema.safeParse({ ...DEFAULT_RESOURCE_LIMITS, memoryMb: 1_000_000 }).success,
    ).toBe(false);
  });
});

describe('transitional states', () => {
  it('names the states that change without anyone asking', () => {
    expect(isRuntimeTransitional('STARTING')).toBe(true);
    expect(isRuntimeTransitional('STOPPING')).toBe(true);
  });

  it('does not include the states that stay put', () => {
    expect(isRuntimeTransitional('RUNNING')).toBe(false);
    expect(isRuntimeTransitional('STOPPED')).toBe(false);
    expect(isRuntimeTransitional('FAILED')).toBe(false);
  });
});

describe('the runtime state response', () => {
  it('can say that a project has no runtime and the platform cannot make one', () => {
    // The two are different facts, and a client has to be able to tell them
    // apart to say anything true to a person.
    const parsed = runtimeStateResponseSchema.parse({
      runtime: null,
      detected: { language: 'node', version: '22', image: 'node:22', evidence: 'package.json' },
      provider: { name: 'none', available: false, reason: 'No execution backend is configured' },
    });

    expect(parsed.runtime).toBeNull();
    expect(parsed.provider.available).toBe(false);
    expect(parsed.provider.reason).not.toBeNull();
  });

  it('requires a reason to be stated whenever one is claimed', () => {
    const parsed = runtimeStateResponseSchema.safeParse({
      runtime: null,
      detected: null,
      provider: { name: 'none', available: false },
    });
    expect(parsed.success).toBe(false);
  });
});
