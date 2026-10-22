export const ANSI_COLORS = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
] as const;

export type AnsiColor = (typeof ANSI_COLORS)[number];

export interface AnsiStyle {
  fg: AnsiColor | undefined;
  bg: AnsiColor | undefined;
  bright: boolean;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
}

export interface AnsiSpan {
  text: string;
  classes: string[];
}

const PLAIN: AnsiStyle = {
  fg: undefined,
  bg: undefined,
  bright: false,
  bold: false,
  dim: false,
  italic: false,
  underline: false,
};

// eslint-disable-next-line no-control-regex -- the escape byte is what is being matched
const CONTROL_SEQUENCE = /\x1b\[([0-9;]*)([A-Za-z])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g;

export function parseAnsi(text: string): AnsiSpan[] {
  const spans: AnsiSpan[] = [];
  let style = PLAIN;
  let last = 0;

  const emit = (chunk: string): void => {
    if (chunk === '') return;
    const classes = classesFor(style);
    const previous = spans.at(-1);
    if (previous && sameClasses(previous.classes, classes)) previous.text += chunk;
    else spans.push({ text: chunk, classes });
  };

  for (const match of text.matchAll(CONTROL_SEQUENCE)) {
    emit(text.slice(last, match.index));
    last = match.index + match[0].length;
    if (match[2] === 'm') style = applySgr(style, match[1] ?? '');
  }
  emit(text.slice(last));
  return spans;
}

export function stripAnsi(text: string): string {
  return text.replace(CONTROL_SEQUENCE, '');
}

function applySgr(current: AnsiStyle, params: string): AnsiStyle {
  const codes = params === '' ? [0] : params.split(';').map((part) => Number(part));
  let style = current;
  for (let i = 0; i < codes.length; i += 1) {
    const code = codes[i] ?? 0;
    if (code === 0) style = PLAIN;
    else if (code === 1) style = { ...style, bold: true };
    else if (code === 2) style = { ...style, dim: true };
    else if (code === 3) style = { ...style, italic: true };
    else if (code === 4) style = { ...style, underline: true };
    else if (code === 22) style = { ...style, bold: false, dim: false };
    else if (code === 23) style = { ...style, italic: false };
    else if (code === 24) style = { ...style, underline: false };
    else if (code >= 30 && code <= 37)
      style = { ...style, fg: ANSI_COLORS[code - 30], bright: false };
    else if (code === 39) style = { ...style, fg: undefined, bright: false };
    else if (code >= 40 && code <= 47) style = { ...style, bg: ANSI_COLORS[code - 40] };
    else if (code === 49) style = { ...style, bg: undefined };
    else if (code >= 90 && code <= 97)
      style = { ...style, fg: ANSI_COLORS[code - 90], bright: true };
    else if (code >= 100 && code <= 107) style = { ...style, bg: ANSI_COLORS[code - 100] };
    else if (code === 38 || code === 48) {
      const mode = codes[i + 1];
      if (mode === 5) {
        const index = codes[i + 2] ?? -1;
        const color = index >= 0 && index < 16 ? ANSI_COLORS[index % 8] : undefined;
        style =
          code === 38
            ? { ...style, fg: color, bright: index >= 8 && index < 16 }
            : { ...style, bg: color };
        i += 2;
      } else if (mode === 2) {
        style =
          code === 38 ? { ...style, fg: undefined, bright: false } : { ...style, bg: undefined };
        i += 4;
      }
    }
  }
  return style;
}

function classesFor(style: AnsiStyle): string[] {
  const classes: string[] = [];
  if (style.fg) classes.push(`ansi-fg-${style.bright || style.bold ? 'bright-' : ''}${style.fg}`);
  if (style.bg) classes.push(`ansi-bg-${style.bg}`);
  if (style.bold) classes.push('ansi-bold');
  if (style.dim) classes.push('ansi-dim');
  if (style.italic) classes.push('ansi-italic');
  if (style.underline) classes.push('ansi-underline');
  return classes;
}

function sameClasses(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}
