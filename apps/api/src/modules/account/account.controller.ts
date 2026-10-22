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

/**
 * HTTP for the account pages.
 *
 * The cookie is the reason this layer exists rather than the routes calling the
 * service directly: three of these operations can end the session making the
 * request, and a browser left holding a cookie for a session that no longer
 * exists spends the next request finding that out. The service has no business
 * knowing what a cookie is.
 */
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
    // Express types a path parameter as possibly repeated. It cannot be here —
    // the pattern has one segment — and narrowing is better than asserting.
    const raw: unknown = req.params.sessionId;
    const sessionId = typeof raw === 'string' ? raw : undefined;

    if (!sessionId) throw new AppError('VALIDATION_FAILED', 'No session was named.');

    const { wasCurrent } = await this.account.revokeSession(user.id, session.id, sessionId);

    // Ending your own session from this page is allowed, so the cookie has to
    // go with it. Leaving it would send the browser back with a credential for
    // a row that is gone.
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

    // The sessions went with the user row. The cookie is cleared so the browser
    // does not spend a request discovering that.
    clearSessionCookie(res, this.cookie);

    const body: DeleteAccountResponse = { projectsDeleted: result.projectsDeleted };
    res.status(200).json(body);
  };
}
