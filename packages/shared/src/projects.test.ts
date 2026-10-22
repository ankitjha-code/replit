import { describe, expect, it } from 'vitest';
import {
  PROJECT_SLUG_MAX_LENGTH,
  createProjectRequestSchema,
  projectSlugSchema,
  slugify,
} from './projects.js';

describe('slugify', () => {
  it('lowercases and hyphenates a plain name', () => {
    expect(slugify('My First Project')).toBe('my-first-project');
  });

  it('folds accents to their base letters', () => {
    // Dropping the letter entirely would turn "Résumé" into "rsum".
    expect(slugify('Café Résumé')).toBe('cafe-resume');
  });

  it('collapses runs of punctuation into one hyphen', () => {
    expect(slugify('a  --  b!!! c')).toBe('a-b-c');
  });

  it('trims leading and trailing hyphens', () => {
    expect(slugify('--My Project--')).toBe('my-project');
  });

  it('keeps digits', () => {
    expect(slugify('Project 2026')).toBe('project-2026');
  });

  it('truncates to the column width without a trailing hyphen', () => {
    const long = slugify(`${'a'.repeat(62)} tail`);
    expect(long.length).toBeLessThanOrEqual(PROJECT_SLUG_MAX_LENGTH);
    expect(long.endsWith('-')).toBe(false);
  });

  it('returns empty when nothing usable survives', () => {
    // The caller asks for a slug rather than inventing something opaque.
    expect(slugify('...')).toBe('');
    expect(slugify('日本語')).toBe('');
    expect(slugify('   ')).toBe('');
  });

  it('always produces something the slug schema accepts', () => {
    for (const name of ['My Project', 'Café', 'a-b', '2026 Ideas', 'X']) {
      const slug = slugify(name);
      expect(projectSlugSchema.safeParse(slug).success).toBe(true);
    }
  });
});

describe('slug rules', () => {
  it('accepts lowercase words separated by single hyphens', () => {
    for (const slug of ['engine', 'my-project', 'x1', 'a-b-c']) {
      expect(projectSlugSchema.safeParse(slug).success).toBe(true);
    }
  });

  it('rejects uppercase, spaces and separators that would need escaping', () => {
    for (const slug of ['My-Project', 'my project', 'my_project', 'my.project', 'my/project']) {
      expect(projectSlugSchema.safeParse(slug).success).toBe(false);
    }
  });

  it('rejects leading, trailing and doubled hyphens', () => {
    for (const slug of ['-engine', 'engine-', 'a--b']) {
      expect(projectSlugSchema.safeParse(slug).success).toBe(false);
    }
  });

  it('rejects slugs that would collide with platform paths', () => {
    for (const slug of ['api', 'health', 'preview', 'settings']) {
      expect(projectSlugSchema.safeParse(slug).success).toBe(false);
    }
  });

  it('rejects anything longer than the column', () => {
    expect(projectSlugSchema.safeParse('a'.repeat(64)).success).toBe(false);
    expect(projectSlugSchema.safeParse('a'.repeat(63)).success).toBe(true);
  });
});

describe('create request', () => {
  it('accepts a name alone', () => {
    expect(createProjectRequestSchema.safeParse({ name: 'My Project' }).success).toBe(true);
  });

  it('trims the name', () => {
    expect(createProjectRequestSchema.parse({ name: '  My Project  ' }).name).toBe('My Project');
  });

  it('rejects an empty or whitespace-only name', () => {
    expect(createProjectRequestSchema.safeParse({ name: '' }).success).toBe(false);
    expect(createProjectRequestSchema.safeParse({ name: '   ' }).success).toBe(false);
  });

  it('rejects a name longer than the column', () => {
    expect(createProjectRequestSchema.safeParse({ name: 'a'.repeat(101) }).success).toBe(false);
  });

  it('accepts an explicit slug', () => {
    const parsed = createProjectRequestSchema.parse({ name: 'My Project', slug: 'custom' });
    expect(parsed.slug).toBe('custom');
  });

  it('rejects an explicit slug that breaks the rules', () => {
    expect(
      createProjectRequestSchema.safeParse({ name: 'My Project', slug: 'Not Valid' }).success,
    ).toBe(false);
  });

  it('bounds the description', () => {
    expect(
      createProjectRequestSchema.safeParse({ name: 'x', description: 'a'.repeat(501) }).success,
    ).toBe(false);
  });

  it('drops fields the client invents', () => {
    const parsed = createProjectRequestSchema.parse({ name: 'x', ownerId: 'someone-else' });
    expect('ownerId' in parsed).toBe(false);
  });
});
