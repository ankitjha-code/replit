import { pino, type Logger } from 'pino';
import { env } from '../config/env.js';

/**
 * Structured logging.
 *
 * Redaction is defined here rather than at each call site so a new logging
 * statement cannot accidentally leak a credential.
 */
const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  'password',
  '*.password',
  'token',
  '*.token',
  'secret',
  '*.secret',
  'secretValue',
  '*.secretValue',
  'DATABASE_URL',
  'SESSION_SECRET',
];

function build(): Logger {
  const { LOG_LEVEL, LOG_PRETTY, NODE_ENV } = env();

  return pino({
    level: NODE_ENV === 'test' ? 'silent' : LOG_LEVEL,
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    base: { service: 'api' },
    timestamp: pino.stdTimeFunctions.isoTime,
    ...(LOG_PRETTY
      ? { transport: { target: 'pino-pretty', options: { colorize: true, singleLine: false } } }
      : {}),
  });
}

let instance: Logger | undefined;

export function logger(): Logger {
  instance ??= build();
  return instance;
}

/** A logger bound to a request/project/runtime for correlated diagnostics. */
export function childLogger(bindings: Record<string, unknown>): Logger {
  return logger().child(bindings);
}
