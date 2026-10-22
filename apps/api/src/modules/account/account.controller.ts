import type { Request, Response } from 'express';
import type {
  ChangePasswordRequest,
  ChangePasswordResponse,
  DeleteAccountRequest,
  DeleteAccountResponse,
  RevokeSessionsResponse,
  SessionListResponse,
} from '@platform/shared';
import { AppError } from '../../errors/app-error.js';
import { requireAuthContext } from '../../http/middleware/authenticate.js';
import { clearSessionCookie, type SessionCookieSettings } from '../../http/session-cookie.js';
import type { AccountService } from './account.service.js';

export class AccountController {
  constructor(
    private readonly account: AccountService,
    private readonly cookie: SessionCookieSettings,
  ) {}

  listSessions = async (req: Request, res: Response): Promise<void> => {
    const { user, session } = requireAuthContext(req);

    const body: SessionListResponse = {
      sessions: await this.account.listSessions(user.id, session.id),
    };
    res.status(200).json(body);
  };

  changePassword = async (req: Request, res: Response): Promise<void> => {
    const { user, session } = requireAuthContext(req);
    const input = req.body as ChangePasswordRequest;

    const result = await this.account.changePassword(user.id, session.id, input);

    const body: ChangePasswordResponse = { signedOut: result.signedOut };
    res.status(200).json(body);
  };

  revokeSession = async (req: Request, res: Response): Promise<void> => {
    const { user, session } = requireAuthContext(req);
    const raw: unknown = req.params.sessionId;
    const sessionId = typeof raw === 'string' ? raw : undefined;

    if (!sessionId) throw new AppError('VALIDATION_FAILED', 'No session was named.');

    const { wasCurrent } = await this.account.revokeSession(user.id, session.id, sessionId);

    if (wasCurrent) clearSessionCookie(res, this.cookie);

    res.status(204).end();
  };

  revokeOthers = async (req: Request, res: Response): Promise<void> => {
    const { user, session } = requireAuthContext(req);

    const body: RevokeSessionsResponse = {
      signedOut: await this.account.revokeOtherSessions(user.id, session.id),
    };
    res.status(200).json(body);
  };

  deleteAccount = async (req: Request, res: Response): Promise<void> => {
    const { user } = requireAuthContext(req);
    const input = req.body as DeleteAccountRequest;

    const result = await this.account.deleteAccount(user.id, input);

    clearSessionCookie(res, this.cookie);

    const body: DeleteAccountResponse = { projectsDeleted: result.projectsDeleted };
    res.status(200).json(body);
  };
}
