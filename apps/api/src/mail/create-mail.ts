import type { Logger } from 'pino';
import type { Env } from '../config/env.js';
import type { MailProvider } from './provider.js';
import { SmtpMailProvider } from './smtp-mail.js';
import { UnavailableMailProvider } from './unavailable-mail.js';

/**
 * Picks a mail provider from configuration.
 *
 * A host and a from-address are the whole requirement. Credentials are
 * optional because a mail container on the same machine does not want any, and
 * demanding them would make the simplest possible development setup the one
 * this refuses.
 *
 * With no host configured the platform gets the provider that refuses and says
 * why, which is what makes an installation without mail a coherent thing rather
 * than a broken one: the features that need it are offered as unavailable
 * instead of failing when somebody tries them.
 */
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
