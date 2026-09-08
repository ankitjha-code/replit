import { AppError } from '../errors/app-error.js';
import type { MailMessage, MailProvider } from './provider.js';

/**
 * The provider an installation gets when no mail server is configured.
 *
 * Not a stub that drops messages. An installation with nowhere to send mail
 * cannot verify an address or reset a password, and saying so is the only
 * honest answer: a provider that accepted a message and discarded it would
 * leave somebody watching an inbox for a message the platform decided not to
 * send, with the platform reporting success.
 *
 * The reason is written to be shown to the person who asked, because they are
 * the one who has to stop waiting — and it names a configuration problem
 * rather than implying they did something wrong.
 */
export class UnavailableMailProvider implements MailProvider {
  readonly name = 'none';

  constructor(
    private readonly reason = 'This installation cannot send email, so addresses cannot be verified and passwords cannot be reset by email. Ask whoever runs it.',
  ) {}

  unavailableReason(): Promise<string | null> {
    return Promise.resolve(this.reason);
  }

  send(_message: MailMessage): Promise<void> {
    return Promise.reject(new AppError('SERVICE_UNAVAILABLE', this.reason, { expose: true }));
  }
}
