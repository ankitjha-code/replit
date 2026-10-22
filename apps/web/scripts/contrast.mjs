// WCAG 2.x contrast for the design-spec token set (both themes).
// Copied from the design spec's directory (ui-design/contrast.mjs); the values here
// are the oracle that styles/tokens.test.ts holds tokens.css to.
// Run: node scripts/contrast.mjs            -> markdown table + failure count
//      node scripts/contrast.mjs --json     -> machine-readable
import console from 'node:console';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
const hex = (h) =>
  h
    .replace('#', '')
    .match(/.{2}/g)
    .map((x) => parseInt(x, 16) / 255);
const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const L = (h) => {
  const [r, g, b] = hex(h).map(lin);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
export const ratio = (a, b) => {
  const [x, y] = [L(a), L(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

export const dark = {
  'bg-canvas': '#0f1114',
  'bg-base': '#141619',
  'bg-raised': '#1a1d21',
  'bg-overlay': '#22262b',
  'bg-input': '#0f1114',
  'border-subtle': '#262a2f',
  'border-strong': '#363b42',
  'border-input': '#6c757f',
  'text-primary': '#e6e9ed',
  'text-secondary': '#a9b1bb',
  'text-muted': '#8d959f',
  'text-disabled': '#6a737e',
  accent: '#ff8a3d',
  'accent-hover': '#ff9d5c',
  'on-accent': '#1a1004',
  'accent-text': '#ffa15e',
  ok: '#5be894',
  'ok-bg': '#12301d',
  warn: '#f5b942',
  'warn-bg': '#332a10',
  danger: '#ff7a76',
  'danger-bg': '#3a1a1a',
  'danger-fill': '#cf3232',
  'danger-fill-hover': '#b82a2a',
  'on-danger': '#ffffff',
  'on-presence': '#15181c',
  info: '#7cc4ff',
  'info-bg': '#122b40',
  focus: '#7cc4ff',
  selection: '#1a2e4a',
  'line-highlight': '#16191d',
  'code-keyword': '#ff9d5c',
  'code-string': '#8fd6a8',
  'code-number': '#f2c46d',
  'code-comment': '#8d959f',
  'code-type': '#7cc4ff',
  'code-function': '#e8c98a',
  'code-variable': '#e6e9ed',
  'code-punctuation': '#a9b1bb',
  'ansi-black': '#3a4047',
  'ansi-bright-black': '#8d959f',
  'ansi-red': '#ff7a76',
  'ansi-green': '#5be894',
  'ansi-yellow': '#f5b942',
  'ansi-blue': '#7cc4ff',
  'ansi-magenta': '#d89bff',
  'ansi-cyan': '#5fd3d0',
  'ansi-white': '#e6e9ed',
  'presence-1': '#7cc4ff',
  'presence-2': '#5be894',
  'presence-3': '#f5b942',
  'presence-4': '#ff8a3d',
  'presence-5': '#d89bff',
  'presence-6': '#5fd3d0',
  'presence-7': '#ff7a76',
  'presence-8': '#c9d1d9',
};

export const light = {
  'bg-canvas': '#fbfcfd',
  'bg-base': '#f1f3f5',
  'bg-raised': '#f9fafb',
  'bg-overlay': '#fdfdfe',
  'bg-input': '#fbfcfd',
  'border-subtle': '#e0e4e9',
  'border-strong': '#c2c8d0',
  'border-input': '#7c8591',
  'text-primary': '#15181c',
  'text-secondary': '#454d57',
  'text-muted': '#5a636f',
  'text-disabled': '#838b95',
  accent: '#c2410c',
  'accent-hover': '#a8360a',
  'on-accent': '#ffffff',
  'accent-text': '#b03a08',
  ok: '#116b33',
  'ok-bg': '#e3f5e9',
  warn: '#7d5300',
  'warn-bg': '#fff1c9',
  danger: '#c62828',
  'danger-bg': '#fdeaea',
  'danger-fill': '#c62828',
  'danger-fill-hover': '#a52020',
  'on-danger': '#ffffff',
  'on-presence': '#ffffff',
  info: '#0b63c4',
  'info-bg': '#e6f0fb',
  focus: '#0b63c4',
  selection: '#dcecff',
  'line-highlight': '#f3f5f7',
  'code-keyword': '#b4470a',
  'code-string': '#176b43',
  'code-number': '#7a5200',
  'code-comment': '#5a636f',
  'code-type': '#1f5fa8',
  'code-function': '#6b4a00',
  'code-variable': '#15181c',
  'code-punctuation': '#454d57',
  'ansi-black': '#15181c',
  'ansi-bright-black': '#5a636f',
  'ansi-red': '#c22f2b',
  'ansi-green': '#176b43',
  'ansi-yellow': '#7a5200',
  'ansi-blue': '#1f5fa8',
  'ansi-magenta': '#8a3fb8',
  'ansi-cyan': '#0b6e6c',
  'ansi-white': '#454d57',
  'presence-1': '#0969da',
  'presence-2': '#1a7f37',
  'presence-3': '#7d5a00',
  'presence-4': '#953800',
  'presence-5': '#6639ba',
  'presence-6': '#0e6b73',
  'presence-7': '#a40e26',
  'presence-8': '#57606a',
};

const surfaces = ['bg-canvas', 'bg-base', 'bg-raised', 'bg-overlay'];
export const pairs = [];
const add = (fg, bg, req, note = '') => pairs.push([fg, bg, req, note]);
// Text tiers on every surface they may sit on (4.5)
for (const t of ['text-primary', 'text-secondary', 'text-muted', 'accent-text'])
  for (const s of surfaces) add(t, s, 4.5);
add('text-primary', 'bg-input', 4.5, 'typed text');
add('text-muted', 'bg-input', 4.5, 'placeholder');
add('text-disabled', 'bg-raised', 3.0, 'disabled label (non-text rule)');
// Semantic text on surfaces and on their tints (4.5)
for (const t of ['ok', 'warn', 'danger', 'info']) {
  for (const s of ['bg-base', 'bg-raised', 'bg-overlay']) add(t, s, 4.5);
  add(t, `${t}-bg`, 4.5, 'callout text on tint');
  add('text-primary', `${t}-bg`, 4.5, 'body on tint');
}
// Filled buttons
add('on-accent', 'accent', 4.5, 'primary button');
add('on-accent', 'accent-hover', 4.5, 'primary hover');
add('on-danger', 'danger-fill', 4.5, 'danger button');
// Non-text: input borders, focus ring, accent as icon/edge (3.0)
for (const s of ['bg-base', 'bg-raised', 'bg-input'])
  add('border-input', s, 3.0, 'input/secondary edge');
for (const s of ['bg-canvas', 'bg-base', 'bg-raised', 'bg-overlay'])
  add('focus', s, 3.0, 'focus ring (outer 2px)');
add('bg-base', 'accent', 3.0, 'focus gap (inner 2px) on a primary button');
add('bg-raised', 'accent', 3.0, 'focus gap on a primary button in a raised toolbar');
add('bg-base', 'danger-fill', 3.0, 'focus gap on a danger button');
add('accent', 'bg-base', 3.0, 'accent as icon/underline');
add('accent', 'bg-raised', 3.0, 'accent as icon/underline');
// Selection and line highlight
add('text-primary', 'selection', 4.5, 'selected text');
add('text-primary', 'line-highlight', 4.5);
// Code on canvas (editor bg), ANSI on canvas (terminal/console bg)
for (const c of [
  'code-keyword',
  'code-string',
  'code-number',
  'code-comment',
  'code-type',
  'code-function',
  'code-variable',
  'code-punctuation',
])
  add(c, 'bg-canvas', 4.5, 'editor');
for (const c of [
  'ansi-red',
  'ansi-green',
  'ansi-yellow',
  'ansi-blue',
  'ansi-magenta',
  'ansi-cyan',
  'ansi-white',
  'ansi-bright-black',
])
  add(c, 'bg-canvas', 4.5, 'terminal/console');
add(
  'ansi-black',
  'bg-canvas',
  1.0,
  'ANSI 0 is never used for text (xterm maps it to bright-black for fg)',
);
for (let i = 1; i <= 8; i++)
  add(`presence-${i}`, 'bg-canvas', 4.5, 'caret label / avatar initials');
for (let i = 1; i <= 8; i++) add(`presence-${i}`, 'bg-raised', 3.0, 'avatar ring');
// Critic additions (2026-09-30): pairs the first table left unmeasured
for (const t of ['ok', 'warn', 'danger', 'info']) {
  add('text-muted', `${t}-bg`, 4.5, 'callout description on tint');
  add('text-secondary', `${t}-bg`, 4.5, 'callout description on tint');
  add('accent-text', `${t}-bg`, 4.5, 'link inside a callout');
}
for (const s of ['bg-canvas', 'bg-base', 'bg-overlay'])
  add('text-disabled', s, 3.0, 'disabled label (non-text rule)');
add('border-input', 'bg-overlay', 3.0, 'input edge inside a dialog');
add('on-danger', 'danger-fill-hover', 4.5, 'danger button hover');
for (const c of [
  'code-keyword',
  'code-string',
  'code-number',
  'code-comment',
  'code-type',
  'code-function',
  'code-variable',
  'code-punctuation',
]) {
  add(c, 'selection', 4.5, 'code inside a selection');
  add(c, 'line-highlight', 4.5, 'code on the current line');
}
for (const c of [
  'ansi-red',
  'ansi-green',
  'ansi-yellow',
  'ansi-blue',
  'ansi-magenta',
  'ansi-cyan',
  'ansi-white',
  'ansi-bright-black',
])
  add(c, 'selection', 4.5, 'terminal text inside a selection');
for (let i = 1; i <= 8; i++) {
  add(`presence-${i}`, 'bg-overlay', 4.5, 'presence list in a popover');
  add('on-presence', `presence-${i}`, 4.5, 'caret name flag text on the presence fill');
}
// Decorative borders (documented, no requirement)
add('border-subtle', 'bg-base', 1.0, 'decorative');
add('border-strong', 'bg-raised', 1.0, 'decorative');

export function measure(sets = { dark, light }) {
  let fail = 0;
  const rows = [];
  for (const [name, set] of Object.entries(sets)) {
    for (const [fg, bg, req, note] of pairs) {
      if (!(fg in set) || !(bg in set)) throw new Error(`${name}: missing ${fg} or ${bg}`);
      const r = ratio(set[fg], set[bg]);
      const ok = r >= req;
      if (!ok) fail++;
      rows.push({
        theme: name,
        fg,
        fgHex: set[fg],
        bg,
        bgHex: set[bg],
        ratio: +r.toFixed(2),
        req,
        ok,
        note,
      });
    }
  }
  return { fail, rows };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const json = process.argv.includes('--json');
  const { fail, rows } = measure();
  if (json) {
    console.log(JSON.stringify({ fail, rows }, null, 1));
  } else {
    console.log('| Theme | Foreground | Background | Ratio | Needs | Pass | Use |');
    console.log('|---|---|---|---|---|---|---|');
    for (const r of rows)
      console.log(
        `| ${r.theme} | \`--${r.fg}\` ${r.fgHex} | \`--${r.bg}\` ${r.bgHex} | ${r.ratio.toFixed(2)} | ${r.req} | ${r.ok ? 'yes' : '**NO**'} | ${r.note} |`,
      );
    console.log(`\n${rows.length} pairs, ${fail} failures`);
  }
  if (fail && !json) process.exitCode = 1;
}
