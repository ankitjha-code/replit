import type { Logger } from 'pino';
import { AppError } from '../../errors/app-error.js';
import type { PasswordHasher } from '../../lib/password.js';
import { generateSessionToken, hashToken, looksLikeSessionToken } from '../../lib/tokens.js';
import type { MailProvider } from '../../mail/provider.js';
import type { SessionRepository } from '../sessions/session.repository.js';
import type { UserRepository, UserRecord } from '../users/user.repository.js';
import type { AccountTokenKind, AccountTokenRepository } from './token.repository.js';

/**
 * Proving an address, and getting back in without a password.
 *
 * Two flows through one service because they share every mechanism — a random
 * token, a hash at rest, a short life, one use — and differ in exactly the ways
 * that matter, which is easier to see when they sit beside each other than when
 * they are in two files pretending to be unrelated.
 *
 * ## What a reset link actually is
 *
 * For as long as it lives, a reset link is the password. Somebody holding it can
 * take the account. Everything below follows from that:
 *
 *  - **It is short-lived**, far shorter than a verification link, because the
 *    window in which a forwarded or logged URL is dangerous should be minutes.
 *  - **It ends every session on use.** A reset is what somebody does when they
 *    believe their account is not theirs alone; leaving the intruder's session
 *    open would make the reset ceremonial.
 *  - **Requesting one is answered identically whether or not the address has an
 *    account.** Otherwise the endpoint is a membership oracle: a way to learn
 *    who is a user here, which is a list of who to phish.
 *  - **Issuing one invalidates the ones before it.** Asking twice should not
 *    leave two live credentials in an inbox.
 *
 * ## What verification is not
 *
 * It is not a gate. Nothing in this platform refuses an unverified account, and
 * that is deliberate rather than unfinished: an installation with no mail server
 * has no way to verify anybody, and a gate would make every account on it
 * useless. What verification gives is a proved address — which is what makes a
 * reset link something that reaches the right person.
 */

export interface VerificationOptions {
  /** How long a verification link lasts. Generous: it proves, it does not grant. */
  verificationTtlMinutes: number;
  /** How long a reset link lasts. Short: for its lifetime it *is* the password. */
  resetTtlMinutes: number;
  /** How many links of one kind an account may be sent per window. */
  maxPerWindow: number;
  windowMinutes: number;
  /** Where a link points. The platform's own public address. */
  publicUrl: string;
}

export class VerificationService {
  constructor(
    private readonly tokens: AccountTokenRepository,
    private readonly users: UserRepository,
    private readonly sessions: SessionRepository,
    private readonly mail: MailProvider,
    private readonly hasher: PasswordHasher,
    private readonly options: VerificationOptions,
    private readonly log: Logger,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Whether this installation can send at all, for a page that must not lie. */
  unavailableReason(): Promise<string | null> {
    return this.mail.unavailableReason();
  }

  /**
   * Sends a verification link to the address on an account.
   *
   * Refuses when the address is already verified, which is the one place this
   * flow can refuse plainly: the person asking is signed in, so there is nothing
   * to conceal from them about their own account.
   */
  async sendVerification(userId: string): Promise<void> {
    const user = await this.users.findById(userId);
    if (!user)
      throw new AppError('UNAUTHENTICATED', 'Sign in again to continue.', { expose: true });

    if (user.emailVerifiedAt) {
      throw new AppError('VALIDATION_FAILED', 'That address is already verified.', {
        expose: true,
      });
    }

    await this.refuseIfMailIsDown();
    await this.refuseIfTooMany(user.id, 'EMAIL_VERIFICATION');

    const token = await this.issue(user, 'EMAIL_VERIFICATION', this.options.verificationTtlMinutes);

    await this.mail.send({
      to: user.email,
      subject: 'Confirm your email address',
      text: [
        `Hello ${user.username},`,
        '',
        'Open this link to confirm this address belongs to you:',
        '',
        `${this.options.publicUrl}/verify-email?token=${token}`,
        '',
        `The link stops working in ${this.options.verificationTtlMinutes} minutes.`,
        'If you did not create an account here, you can ignore this message.',
      ].join('\n'),
    });

    this.log.info({ userId: user.id }, 'a verification link was sent');
  }

  /**
   * Redeems a verification link.
   *
   * The address recorded on the **token** is what gets verified, not the one on
   * the account now. Without that, changing an address and then opening an older
   * link would mark the new address proved on the strength of a message
   * delivered to the old one.
   */
  async confirmVerification(rawToken: string): Promise<{ email: string }> {
    const record = await this.redeem(rawToken, 'EMAIL_VERIFICATION');
    const user = await this.users.findById(record.userId);

    if (!user) {
      throw new AppError('NOT_FOUND', 'That account no longer exists.', { expose: true });
    }

    if (user.email !== record.email) {
      /*
       * The address moved on. The link proves nothing about the current one.
       *
       * Spent rather than left open, because the token was redeemed above and
       * re-offering it would be a live credential for an address that is no
       * longer on the account.
       */
      throw new AppError(
        'VALIDATION_FAILED',
        'That link was sent to a different address than the one on this account. Ask for a new one.',
        { expose: true },
      );
    }

    await this.users.markEmailVerified(user.id, this.now());
    this.log.info({ userId: user.id }, 'an email address was verified');

    return { email: user.email };
  }

  /**
   * Starts a password reset, and says nothing about whether it could.
   *
   * Every path through this method returns the same thing. No account, an
   * account that exists, a mail server that is down, too many requests already:
   * all of them look identical from outside, because the difference between
   * them is precisely the fact worth hiding.
   *
   * The consequences are real and accepted. Somebody who mistypes their address
   * is told the same as somebody who did not, and only the message that arrives
   * — or does not — tells them apart. And an installation with no mail server
   * accepts the request and does nothing, which is the one case where this
   * silence is uncomfortable: it is covered by the sign-in page saying up front
   * that resets are unavailable, rather than by making this endpoint answer
   * differently.
   */
  async requestReset(email: string): Promise<void> {
    const user = await this.users.findByEmail(email);

    if (!user) {
      this.log.info('a reset was requested for an address with no account');
      return;
    }

    if (await this.mail.unavailableReason()) {
      this.log.warn({ userId: user.id }, 'a reset was requested but mail is unavailable');
      return;
    }

    if (await this.tooMany(user.id, 'PASSWORD_RESET')) {
      this.log.warn({ userId: user.id }, 'a reset was requested too often and was not sent');
      return;
    }

    const token = await this.issue(user, 'PASSWORD_RESET', this.options.resetTtlMinutes);

    try {
      await this.mail.send({
        to: user.email,
        subject: 'Reset your password',
        text: [
          `Hello ${user.username},`,
          '',
          'Somebody asked to reset the password on your account. Open this link to choose a new one:',
          '',
          `${this.options.publicUrl}/reset-password?token=${token}`,
          '',
          `The link stops working in ${this.options.resetTtlMinutes} minutes, and using it signs you out everywhere.`,
          'If this was not you, you do not need to do anything: your password has not changed.',
        ].join('\n'),
      });
    } catch (error) {
      /*
       * Swallowed, uniquely in this file.
       *
       * Everywhere else a failure to send fails the operation, because the
       * person is waiting and deserves to know. Here, letting it out would make
       * this endpoint answer differently for an address that exists — which is
       * the oracle the whole method is built to avoid. It is logged loudly
       * instead.
       */
      this.log.error({ err: error, userId: user.id }, 'a reset message could not be sent');
    }

    this.log.info({ userId: user.id }, 'a reset link was sent');
  }

  /**
   * Finishes a reset: new password, and every session ended.
   *
   * Every session, including any the person is holding right now. Signing in
   * again with the password they just chose is a small cost, and the alternative
   * is deciding which sessions to trust at the exact moment somebody has told
   * the platform they are not sure.
   */
  async completeReset(rawToken: string, password: string): Promise<void> {
    const record = await this.redeem(rawToken, 'PASSWORD_RESET');
    const user = await this.users.findById(record.userId);

    if (!user) {
      throw new AppError('NOT_FOUND', 'That account no longer exists.', { expose: true });
    }

    await this.users.updatePasswordHash(user.id, await this.hasher.hash(password));

    const signedOut = await this.sessions.deleteAllForUser(user.id);

    /*
     * The address is verified as a side effect, and it is not a shortcut.
     *
     * A reset link only works if it was read, and it was sent to the address on
     * the account. That is the same proof verification asks for, so refusing to
     * count it would leave somebody who has just demonstrated control of their
     * inbox still being asked to demonstrate it.
     */
    if (!user.emailVerifiedAt && user.email === record.email) {
      await this.users.markEmailVerified(user.id, this.now());
    }

    this.log.info({ userId: user.id, signedOut }, 'a password was reset');
  }

  /** Issues a token, retiring any outstanding one of the same kind. */
  private async issue(
    user: UserRecord,
    kind: AccountTokenKind,
    ttlMinutes: number,
  ): Promise<string> {
    const now = this.now();

    await this.tokens.invalidateOutstanding(user.id, kind, now);

    const token = generateSessionToken();

    await this.tokens.create({
      userId: user.id,
      kind,
      tokenHash: hashToken(token),
      email: user.email,
      expiresAt: new Date(now.getTime() + ttlMinutes * 60_000),
    });

    return token;
  }

  /**
   * Turns a token into the record it names, spending it in the process.
   *
   * The shape-check first is a cheap filter, not a security control: it avoids a
   * database round trip for a value that cannot be one of ours.
   *
   * Three different refusals rather than one. "Expired" and "already used" are
   * things somebody can act on — ask for another, or realise it worked the first
   * time — and collapsing them into "invalid" leaves people clicking the same
   * dead link.
   */
  private async redeem(rawToken: string, kind: AccountTokenKind) {
    const generic = new AppError(
      'VALIDATION_FAILED',
      'That link is not valid. Ask for a new one.',
      {
        expose: true,
      },
    );

    if (!looksLikeSessionToken(rawToken)) throw generic;

    const record = await this.tokens.findByHash(hashToken(rawToken));

    // Kind is checked as well as existence: a verification link must not be
    // redeemable as a reset, which is the whole reason the column is there.
    if (!record || record.kind !== kind) throw generic;

    if (record.usedAt) {
      throw new AppError('VALIDATION_FAILED', 'That link has already been used.', { expose: true });
    }

    if (record.expiresAt.getTime() <= this.now().getTime()) {
      throw new AppError('VALIDATION_FAILED', 'That link has expired. Ask for a new one.', {
        expose: true,
      });
    }

    /*
     * Spent before anything is done with it.
     *
     * The update is conditional on it still being unused, so two requests
     * carrying the same token — a double click, a mail client prefetching a URL
     * — cannot both proceed. The one that loses is told the link has been used,
     * which is true.
     */
    if (!(await this.tokens.markUsed(record.id, this.now()))) {
      throw new AppError('VALIDATION_FAILED', 'That link has already been used.', { expose: true });
    }

    return record;
  }

  private async refuseIfMailIsDown(): Promise<void> {
    const reason = await this.mail.unavailableReason();
    if (reason) throw new AppError('SERVICE_UNAVAILABLE', reason, { expose: true });
  }

  private async refuseIfTooMany(userId: string, kind: AccountTokenKind): Promise<void> {
    if (await this.tooMany(userId, kind)) {
      throw new AppError(
        'RATE_LIMITED',
        'Too many messages have been sent to this address recently. Try again shortly.',
        { expose: true },
      );
    }
  }

  /**
   * A ceiling per account, beside the per-address one in the routes.
   *
   * They stop different things. The route limiter stops one client hammering
   * the endpoint; this stops many clients doing it to one person, which is what
   * turns a reset endpoint into a way to fill somebody's inbox.
   */
  private async tooMany(userId: string, kind: AccountTokenKind): Promise<boolean> {
    const since = new Date(this.now().getTime() - this.options.windowMinutes * 60_000);
    return (await this.tokens.countSince(userId, kind, since)) >= this.options.maxPerWindow;
  }
}
