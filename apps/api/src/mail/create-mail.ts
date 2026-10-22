import type { Logger } from 'pino';
import type { Env } from '../config/env.js';
import type { MailProvider } from './provider.js';
import { SmtpMailProvider } from './smtp-mail.js';
import { UnavailableMailProvider } from './unavailable-mail.js';

export function createMailProvider(config: Env, log: Logger): MailProvider {
  const { SMTP_HOST, MAIL_FROM } = config;

  if (!SMTP_HOST || !MAIL_FROM) return new UnavailableMailProvider();

  return new SmtpMailProvider(
    {
      host: SMTP_HOST,
      port: config.SMTP_PORT,
      secure: config.SMTP_SECURE,
      user: config.SMTP_USER,
      password: config.SMTP_PASSWORD,
      from: MAIL_FROM,
      timeoutMs: config.SMTP_TIMEOUT_MS,
      availabilityTtlMs: config.MAIL_AVAILABILITY_TTL_MS,
    },
    log,
  );
}
