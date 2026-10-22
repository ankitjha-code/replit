import type { Request, Response } from 'express';
import type {
  RunState,
  SetRunCommandRequest,
  RuntimeHistoryResponse,
  WorkspaceSyncResult,
  RuntimeStateResponse,
  StartRuntimeRequest,
  TerminalSessionsResponse,
} from '@platform/shared';
import { requireAuthContext } from '../../http/middleware/authenticate.js';
import { requireProjectAccess } from '../../http/middleware/authorize-project.js';
import type { RunService } from './run.service.js';
import type { RuntimeService } from './runtime.service.js';
import type { TerminalSessionService } from './terminal-session.service.js';

export class RuntimeController {
  constructor(
    private readonly runtimes: RuntimeService,
    private readonly runs: RunService,
    private readonly terminals: TerminalSessionService,
  ) {}

  terminalSessions = async (req: Request, res: Response): Promise<void> => {
    const { project } = requireProjectAccess(req);
    const { user } = requireAuthContext(req);
    const body: TerminalSessionsResponse = {
      sessions: await this.terminals.list(project.id, user.id),
    };
    res.status(200).json(body);
  };

  closeTerminalSession = async (req: Request, res: Response): Promise<void> => {
    const { project } = requireProjectAccess(req);
    const { user } = requireAuthContext(req);
    const sessionId = req.params.sessionId;
    if (typeof sessionId !== 'string') {
      res.status(204).end();
      return;
    }

    await this.terminals.closeSession(sessionId, project.id, user.id);
    res.status(204).end();
  };

  run = async (req: Request, res: Response): Promise<void> => {
    const { project } = requireProjectAccess(req);
    const body: RunState = await this.runs.describe(project.id);
    res.status(200).json(body);
  };

  startRun = async (req: Request, res: Response): Promise<void> => {
    const { project } = requireProjectAccess(req);
    const body: RunState = await this.runs.start(project.id);
    res.status(200).json(body);
  };

  stopRun = async (req: Request, res: Response): Promise<void> => {
    const { project } = requireProjectAccess(req);
    const body: RunState = await this.runs.stop(project.id);
    res.status(200).json(body);
  };

  setRunCommand = async (req: Request, res: Response): Promise<void> => {
    const { project } = requireProjectAccess(req);
    const input = req.body as SetRunCommandRequest;
    const body: RunState = await this.runs.setCommand(project.id, input.command);
    res.status(200).json(body);
  };

  get = async (req: Request, res: Response): Promise<void> => {
    const { project } = requireProjectAccess(req);
    const body: RuntimeStateResponse = await this.runtimes.describe(project.id);
    res.status(200).json(body);
  };

  start = async (req: Request, res: Response): Promise<void> => {
    const { project } = requireProjectAccess(req);
    const { user } = requireAuthContext(req);
    const input = req.body as StartRuntimeRequest;

    const body: RuntimeStateResponse = await this.runtimes.start(
      project.id,
      user.id,
      input.language,
    );
    res.status(200).json(body);
  };

  stop = async (req: Request, res: Response): Promise<void> => {
    const { project } = requireProjectAccess(req);
    const { user } = requireAuthContext(req);

    const body: RuntimeStateResponse = await this.runtimes.stop(project.id, user.id);
    res.status(200).json(body);
  };

  sync = async (req: Request, res: Response): Promise<void> => {
    const { project } = requireProjectAccess(req);
    const body: WorkspaceSyncResult = await this.runtimes.syncWorkspace(project.id);
    res.status(200).json(body);
  };

  history = async (req: Request, res: Response): Promise<void> => {
    const { project } = requireProjectAccess(req);
    const events = await this.runtimes.history(project.id);

    const body: RuntimeHistoryResponse = {
      events: events.map((event) => ({
        id: event.id,
        from: event.fromStatus,
        to: event.toStatus,
        reason: event.reason,
        at: event.createdAt.toISOString(),
      })),
    };
    res.status(200).json(body);
  };
}
