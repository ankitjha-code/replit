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

  requestReset = async (req: Request, res: Response): Promise<void> => {
    const { email } = req.body as PasswordResetRequest;
    await this.verification.requestReset(email);

    const body: PasswordResetResponse = { accepted: true };
    res.status(202).json(body);
  };

  completeReset = async (req: Request, res: Response): Promise<void> => {
    const { token, password } = req.body as PasswordResetComplete;
    await this.verification.completeReset(token, password);

    clearSessionCookie(res, this.cookie);
    res.status(204).end();
  };
}
