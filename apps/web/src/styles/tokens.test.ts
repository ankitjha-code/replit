import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { dark, light, measure } from '../../scripts/contrast.mjs';

const SRC = join(__dirname, '..');
const TOKENS = join(__dirname, 'tokens.css');
const css = readFileSync(TOKENS, 'utf8');

function block(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`tokens.css has no block for ${selector}`);
  let depth = 0;
  let end = start;
  for (let i = start + selector.length + 1; i < css.length; i++) {
    if (css[i] === '{') depth++;
    if (css[i] === '}' && --depth === 0) {
      end = i;
      break;
    }
  }
  const body = css.slice(start, end).replace(/\/\*[\s\S]*?\*\//g, '');
  const out: Record<string, string> = {};
  for (const [, name, value] of body.matchAll(/(--[\w-]+|color-scheme):\s*([^;]+);/g)) {
    if (name && value) out[name] = value.replace(/\s+/g, ' ').trim();
  }
  return out;
}

const cssDark = block(':root');
const cssLightSystem = block(":root:not([data-theme='dark'])");
const cssLightChosen = block(":root[data-theme='light']");

function colours(declared: Record<string, string>, oracle: Record<string, string>) {
  const out: Record<string, string> = {};
  for (const name of Object.keys(oracle)) out[name] = declared[`--${name}`]?.toLowerCase() ?? '';
  return out;
}

describe('tokens.css', () => {
  it('declares every colour the spec measured, dark on :root', () => {
    expect(colours(cssDark, dark)).toEqual(dark);
    expect(cssDark['color-scheme']).toBe('dark');
  });

  it('declares the light palette for the system preference', () => {
    expect(colours({ ...cssDark, ...cssLightSystem }, light)).toEqual(light);
    expect(cssLightSystem['color-scheme']).toBe('light');
  });

  it('applies the same light palette when the user chose light', () => {
    expect(cssLightChosen).toEqual(cssLightSystem);
  });

  it('reproduces Appendix A: 296 pairs, 0 failures, from the declared values', () => {
    const { fail, rows } = measure({
      dark: colours(cssDark, dark),
      light: colours({ ...cssDark, ...cssLightSystem }, light),
    });
    const failed = rows
      .filter((row) => !row.ok)
      .map((r) => `${r.theme} ${r.fg} on ${r.bg}: ${r.ratio}`);
    expect(failed).toEqual([]);
    expect(fail).toBe(0);
    expect(rows).toHaveLength(296);
  });

  it('declares none of the legacy aliases the old stylesheets needed', () => {
    const aliases = [
      'status-ok',
      'status-warn',
      'status-down',
      'success',
      'warning',
      'surface',
      'surface-raised',
      'surface-sunken',
      'radius-sm',
      'radius-md',
      'space-5',
    ];
    for (const name of aliases) expect(cssDark[`--${name}`], name).toBeUndefined();
  });

  it('keeps the 4px spacing scale', () => {
    expect(cssDark['--space-1']).toBe('4px');
    expect(cssDark['--space-2']).toBe('8px');
    expect(cssDark['--space-8']).toBe('32px');
  });
});

const TEMPLATE_TEXT_FILES = new Set(['lib/starter-templates.ts']);

const HEX = /(?<![&\w])#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})\b/i;
const FUNCTIONAL = /\b(?:rgba?|hsla?|oklch|color-mix)\(/;

function* sources(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* sources(full);
    else if (/\.(css|ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) yield full;
  }
}

describe('raw colours', () => {
  it('appear only in tokens.css', () => {
    const offenders: string[] = [];
    for (const file of sources(SRC)) {
      const rel = relative(SRC, file);
      if (rel === 'styles/tokens.css' || TEMPLATE_TEXT_FILES.has(rel)) continue;
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, index) => {
        if (HEX.test(line) || FUNCTIONAL.test(line))
          offenders.push(`${rel}:${index + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
