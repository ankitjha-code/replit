import type { ITheme } from '@xterm/xterm';
import { readToken, type TokenReader } from './read-tokens.js';
import type { Theme } from './theme.js';

export function terminalTheme(_theme: Theme, read: TokenReader = readToken): ITheme {
  return {
    background: read('--bg-canvas'),
    foreground: read('--text-primary'),
    cursor: read('--accent'),
    cursorAccent: read('--bg-canvas'),
    selectionBackground: read('--selection'),
    black: read('--ansi-black'),
    red: read('--ansi-red'),
    green: read('--ansi-green'),
    yellow: read('--ansi-yellow'),
    blue: read('--ansi-blue'),
    magenta: read('--ansi-magenta'),
    cyan: read('--ansi-cyan'),
    white: read('--ansi-white'),
    brightBlack: read('--ansi-bright-black'),
    brightRed: read('--ansi-red'),
    brightGreen: read('--ansi-green'),
    brightYellow: read('--ansi-yellow'),
    brightBlue: read('--ansi-blue'),
    brightMagenta: read('--ansi-magenta'),
    brightCyan: read('--ansi-cyan'),
    brightWhite: read('--text-primary'),
  };
}
