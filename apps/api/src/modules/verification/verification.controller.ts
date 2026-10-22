import type { Request, Response } from 'express';
import type {
  ConfirmTokenRequest,
  PasswordResetComplete,
  PasswordResetRequest,
  PasswordResetResponse,
  VerificationStatus,
} from '@platform/shared';
import { requireAuthContext } from '../../http/middleware/authenticate.js';
import { clearSessionCookie, type SessionCookieSettings } from '../../http/session-cookie.js';
import type { VerificationService } from './verification.service.js';

export class VerificationController {
  constructor(
    private readonly verification: VerificationService,
    private readonly cookie: SessionCookieSettings,
  ) {}

  /**
   * What the account's address is and whether asking is even possible.
   *
   * `canSend` is here so a page never offers a button that cannot work. An
   * installation with no mail server explains instead of inviting a click, which
   * is the difference between a missing feature and a broken one.
   */
  status = async (req: Request, res: Response): Promise<void> => {
    const { user } = requireAuthContext(req);
    const reason = await this.verification.unavailableReason();

    const body: VerificationStatus = {
      email: user.email,
      verified: user.emailVerifiedAt !== null,
      canSend: reason === null,
      reason,
    };
    res.status(200).json(body);
  };

  sendVerification = async (req: Request, res: Response): Promise<void> => {
    const { user } = requireAuthContext(req);
    await this.verification.sendVerification(user.id);
    res.status(202).end();
  };

  confirmVerification = async (req: Request, res: Response): Promise<void> => {
    const { token } = req.body as ConfirmTokenRequest;
    const result = await this.verification.confirmVerification(token);
    res.status(200).json(result);
  };

  /**
   * Always accepted, whatever happened.
   *
   * The service returns without saying whether an account exists, whether mail
   * is working, or whether too many have already been sent. Answering
   * differently for any of those would make this a way to learn who has an
   * account here.
   */
  requestReset = async (req: Request, res: Response): Promise<void> => {
    const { email } = req.body as PasswordResetRequest;
    await this.verification.requestReset(email);

    const body: PasswordResetResponse = { accepted: true };
    res.status(202).json(body);
  };

  completeReset = async (req: Request, res: Response): Promise<void> => {
    const { token, password } = req.body as PasswordResetComplete;
    await this.verification.completeReset(token, password);

    /*
     * Every session ended, including this browser's if it had one.
     *
     * Somebody resetting a password may well be signed in on the device doing
     * it. The cookie is cleared so the browser does not carry a credential for a
     * session that no longer exists, and signing in with the new password is the
     * next thing the page asks for.
     */
    clearSessionCookie(res, this.cookie);
    res.status(204).end();
  };
}
