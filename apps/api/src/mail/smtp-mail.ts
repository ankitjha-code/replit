import { createTransport, type Transporter } from 'nodemailer';
import type { Logger } from 'pino';
import { AppError } from '../errors/app-error.js';
import type { MailMessage, MailProvider } from './provider.js';

export interface SmtpMailOptions {
  host: string;
  port: number;
  secure: boolean;
  user: string | undefined;
  password: string | undefined;
  from: string;
  timeoutMs: number;
  availabilityTtlMs: number;
}

export class SmtpMailProvider implements MailProvider {
  readonly name = 'smtp';

  private readonly transport: Transporter;
  private availability: { reason: string | null; at: number } | undefined;

  constructor(
    private readonly options: SmtpMailOptions,
    private readonly log: Logger,
  ) {
    this.transport = createTransport({
      host: options.host,
      port: options.port,
      secure: options.secure,
      ...(options.user ? { auth: { user: options.user, pass: options.password ?? '' } } : {}),
      connectionTimeout: options.timeoutMs,
      greetingTimeout: options.timeoutMs,
      socketTimeout: options.timeoutMs,
    });
  }

  async unavailableReason(): Promise<string | null> {
    const cached = this.availability;
    if (cached && Date.now() - cached.at < this.options.availabilityTtlMs) return cached.reason;

    let reason: string | null;
    try {
      await this.transport.verify();
      reason = null;
    } catch (error) {
      this.log.warn({ err: error }, 'the mail server is not reachable');
      reason = 'The mail server is not reachable, so the platform cannot send email right now.';
    }

    this.availability = { reason, at: Date.now() };
    return reason;
  }

  async send(message: MailMessage): Promise<void> {
    try {
      await this.transport.sendMail({
        from: this.options.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
      });
    } catch (error) {
      this.log.error({ err: error, to: message.to }, 'a message could not be sent');

      this.availability = undefined;

      throw new AppError(
        'SERVICE_UNAVAILABLE',
        'The message could not be sent. Try again in a moment.',
        { expose: true, cause: error },
      );
    }
  }
}
