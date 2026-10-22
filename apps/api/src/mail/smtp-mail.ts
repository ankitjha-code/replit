import { createTransport, type Transporter } from 'nodemailer';
import type { Logger } from 'pino';
import { AppError } from '../errors/app-error.js';
import type { MailMessage, MailProvider } from './provider.js';

/**
 * Sends mail through an SMTP server the operator names.
 *
 * SMTP rather than a mail API, deliberately. Every hosted mail service has its
 * own SDK, its own credentials and its own account, and choosing one would make
 * a paid third party part of being able to run this platform. SMTP is the one
 * thing every mail service and every self-hosted mail server already speaks, so
 * an installation can point at a container on the same machine, a company
 * relay, or a commercial service, and the platform never knows the difference.
 *
 * ## Nothing here logs a message
 *
 * Every message this platform sends carries a single-use credential in a URL. A
 * log of what was sent would be a log of those credentials, readable by anybody
 * who can read logs — which is a wider group than the people the messages were
 * addressed to. What is logged is that a send failed, and to nothing more
 * specific than a recipient.
 */

export interface SmtpMailOptions {
  host: string;
  port: number;
  /**
   * Whether the connection is TLS from the first byte.
   *
   * False does **not** mean plaintext: nodemailer still upgrades with STARTTLS
   * when the server offers it, which is what a submission port on 587 does.
   * True is for a port that expects TLS immediately, conventionally 465.
   */
  secure: boolean;
  user: string | undefined;
  password: string | undefined;
  /** What the message says it is from. Usually has to match the account. */
  from: string;
  /** How long a probe or a send may take before it is given up on. */
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
      /*
       * Credentials only when there are any.
       *
       * A local mail container accepts anonymous submission, and passing an
       * empty user makes the client offer an authentication it cannot complete
       * — which fails a connection that would otherwise have worked.
       */
      ...(options.user ? { auth: { user: options.user, pass: options.password ?? '' } } : {}),
      connectionTimeout: options.timeoutMs,
      greetingTimeout: options.timeoutMs,
      socketTimeout: options.timeoutMs,
    });
  }

  /**
   * Whether the mail server answers.
   *
   * Cached briefly, like every other provider's: this is asked before each
   * token is written and on the health page, and a round trip per request buys
   * nothing when the answer changes on the timescale of an outage.
   *
   * `verify` opens a connection and greets, so it tests reachability and
   * credentials together. It does not test whether anything is delivered, which
   * nothing can from here.
   */
  async unavailableReason(): Promise<string | null> {
    const cached = this.availability;
    if (cached && Date.now() - cached.at < this.options.availabilityTtlMs) return cached.reason;

    let reason: string | null;
    try {
      await this.transport.verify();
      reason = null;
    } catch (error) {
      this.log.warn({ err: error }, 'the mail server is not reachable');
      // Names what is wrong without quoting the driver, whose message carries a
      // host, a port and sometimes a user name.
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
      /*
       * The recipient is logged and the message is not.
       *
       * Somebody investigating "I never got the email" needs to know whether the
       * platform tried and failed, and for whom. The body is the part that must
       * never be written down.
       */
      this.log.error({ err: error, to: message.to }, 'a message could not be sent');

      // A cached "reachable" is not to be trusted after a failure to send.
      this.availability = undefined;

      throw new AppError(
        'SERVICE_UNAVAILABLE',
        'The message could not be sent. Try again in a moment.',
        { expose: true, cause: error },
      );
    }
  }
}
