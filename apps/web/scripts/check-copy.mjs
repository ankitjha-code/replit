// Copy gate for UI strings: no em-dashes and none of the names the glossary
// (design spec section 7) retired. Run: node scripts/check-copy.mjs [paths...]
// Defaults to src/. Exit code 1 when anything is found.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import process from 'node:process';
import { URL, fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const EXTENSIONS = new Set(['.ts', '.tsx']);

// Each entry: what the UI must not say, and what the glossary says instead.
const BANNED = [
  [/—/g, 'em-dash (use a comma, a colon or a full stop)'],
  [/\bprovision(ing|ed)?\b/gi, 'Start'],
  [/\bboot(ing|ed)?\b/gi, 'Start'],
  [/\bbackground (work|jobs?)\b/gi, 'Activity'],
  [/\bresources and health\b/gi, 'Monitoring'],
  [/\bcontrol plane\b/gi, 'System status'],
  [/\bpublished at\b/gi, 'Live URL'],
  [/\baddress on this platform\b/gi, 'Platform subdomain'],
  [/\bturn off\b/gi, 'Revoke or Remove'],
  [/\bkeep (it|them)\b/gi, 'Cancel'],
  [/\byes, delete it\b/gi, 'Delete {object}'],
  [/\bread from runtime\b/gi, 'Sync files'],
];

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (EXTENSIONS.has(full.slice(full.lastIndexOf('.')))) yield full;
  }
}

const targets = process.argv.slice(2);
const files = [];
for (const target of targets.length ? targets : ['src']) {
  const full = join(ROOT, target);
  if (statSync(full).isDirectory()) files.push(...walk(full));
  else files.push(full);
}

const findings = [];
for (const file of files) {
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, index) => {
    // Comments and imports are not UI strings.
    if (/^\s*(\/\/|\*|\/\*|import\b)/.test(line)) return;
    for (const [pattern, instead] of BANNED) {
      pattern.lastIndex = 0;
      if (pattern.test(line)) {
        findings.push(`${relative(ROOT, file)}:${index + 1}: ${line.trim()}\n    use: ${instead}`);
      }
    }
  });
}

if (findings.length) {
  process.stdout.write(`${findings.join('\n')}\n\n${findings.length} finding(s)\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`check-copy: ${files.length} files clean\n`);
}
