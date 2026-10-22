import { describe, expect, it } from 'vitest';
import {
  clientMessageSchema,
  MAX_INPUT_BYTES,
  projectIdFromTerminalPath,
  serverMessageSchema,
  terminalPath,
  terminalSizeSchema,
} from './terminal.js';

/**
 * The terminal protocol.
 *
 * Every message crossing this socket is validated, in both directions. The
 * client's are attacker-controlled and the server's are what a browser acts
 * on, so neither is trusted because of where it came from.
 */

describe('what a client may send', () => {
  it('accepts keystrokes', () => {
    expect(clientMessageSchema.parse({ type: 'input', data: 'ls\r' })).toEqual({
      type: 'input',
      data: 'ls\r',
    });
  });

  it('accepts a resize', () => {
    const parsed = clientMessageSchema.parse({
      type: 'resize',
      size: { columns: 120, rows: 40 },
    });
    expect(parsed).toEqual({ type: 'resize', size: { columns: 120, rows: 40 } });
  });

  it('refuses a message with no type it knows', () => {
    expect(clientMessageSchema.safeParse({ type: 'exec', data: 'rm -rf /' }).success).toBe(false);
  });

  it('refuses input larger than a paste could plausibly be', () => {
    // One frame must not be a way to make the server hold arbitrary memory.
    const huge = 'x'.repeat(MAX_INPUT_BYTES + 1);
    expect(clientMessageSchema.safeParse({ type: 'input', data: huge }).success).toBe(false);
  });

  it('refuses a size that is not a window', () => {
    // These numbers become a pseudo-terminal's dimensions.
    for (const size of [
      { columns: 0, rows: 24 },
      { columns: 80, rows: 0 },
      { columns: 1_000_000, rows: 24 },
      { columns: 80.5, rows: 24 },
      { columns: -80, rows: 24 },
    ]) {
      expect(terminalSizeSchema.safeParse(size).success).toBe(false);
    }
  });

  it('accepts the sizes a real window has', () => {
    expect(terminalSizeSchema.safeParse({ columns: 80, rows: 24 }).success).toBe(true);
    expect(terminalSizeSchema.safeParse({ columns: 400, rows: 100 }).success).toBe(true);
  });
});

describe('what a server may send', () => {
  it('carries output', () => {
    expect(serverMessageSchema.safeParse({ type: 'output', data: 'hello\r\n' }).success).toBe(true);
  });

  it('carries an exit code, which may be unknown', () => {
    expect(serverMessageSchema.safeParse({ type: 'exit', code: 0 }).success).toBe(true);
    expect(serverMessageSchema.safeParse({ type: 'exit', code: null }).success).toBe(true);
  });

  it('carries a failure with a code and a message', () => {
    // The code lets a client tell "start the project first" from "you are not
    // allowed" without reading the prose.
    const parsed = serverMessageSchema.parse({
      type: 'error',
      code: 'RUNTIME_NOT_RUNNING',
      message: 'Start the project before opening a terminal.',
    });
    expect(parsed.type).toBe('error');
  });

  it('refuses a failure with no reason attached', () => {
    expect(serverMessageSchema.safeParse({ type: 'error', code: 'FORBIDDEN' }).success).toBe(false);
  });
});

describe('the terminal address', () => {
  it('round-trips a project identifier', () => {
    const id = '018f0000-0000-7000-8000-0000000000aa';
    expect(projectIdFromTerminalPath(terminalPath(id))).toBe(id);
  });

  it('refuses anything that is not exactly this route', () => {
    // A near miss is refused rather than coerced into something plausible.
    for (const path of [
      '/ws/projects//terminal',
      '/ws/projects/abc',
      '/ws/projects/abc/terminal/extra',
      '/ws/terminal',
      '/api/projects/abc/terminal',
      '',
    ]) {
      expect(projectIdFromTerminalPath(path)).toBeUndefined();
    }
  });

  it('escapes an identifier into the path', () => {
    expect(terminalPath('a/b')).toBe('/ws/projects/a%2Fb/terminal');
  });
});
