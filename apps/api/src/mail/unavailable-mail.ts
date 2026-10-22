import { AppError } from '../errors/app-error.js';
import type { MailMessage, MailProvider } from './provider.js';

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
