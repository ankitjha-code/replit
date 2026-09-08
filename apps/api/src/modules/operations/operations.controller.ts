import type { Request, Response } from 'express';
import type {
  OperationsOverview,
  RunSweepRequest,
  SetHostDrainRequest,
  SetOperatorRequest,
  SetQuotaOverrideRequest,
  SweepReportView,
} from '@platform/shared';
import { AppError } from '../../errors/app-error.js';
import { requireAuthContext } from '../../http/middleware/authenticate.js';
import type { SweepReport, SweepStep } from '../maintenance/orphan-sweeper.js';
import type { OperationsService } from './operations.service.js';

export class OperationsController {
  constructor(private readonly operations: OperationsService) {}

  overview = async (_req: Request, res: Response): Promise<void> => {
    const body: OperationsOverview = await this.operations.overview();
    res.status(200).json(body);
  };

  hosts = async (_req: Request, res: Response): Promise<void> => {
    res.status(200).json({ hosts: await this.operations.hosts() });
  };

  accounts = async (req: Request, res: Response): Promise<void> => {
    const raw: unknown = req.query.after;
    const after = typeof raw === 'string' && raw.length > 0 ? raw : undefined;

    res.status(200).json(await this.operations.accounts(after));
  };

  setOperator = async (req: Request, res: Response): Promise<void> => {
    const { user } = requireAuthContext(req);

    const raw: unknown = req.params.accountId;
    const accountId = typeof raw === 'string' ? raw : undefined;
    if (!accountId) throw new AppError('VALIDATION_FAILED', 'No account was named.');

    const { isOperator } = req.body as SetOperatorRequest;

    await this.operations.setOperator(user.id, accountId, isOperator);
    res.status(204).end();
  };

  drain = async (req: Request, res: Response): Promise<void> => {
    const { user } = requireAuthContext(req);
    const raw: unknown = req.params.hostName;
    if (typeof raw !== 'string' || raw.length === 0) {
      throw new AppError('VALIDATION_FAILED', 'No host was named.');
    }
    const { draining } = req.body as SetHostDrainRequest;
    res.status(200).json({ hosts: await this.operations.setDrain(user.id, raw, draining) });
  };

  quotas = async (req: Request, res: Response): Promise<void> => {
    const accountId = accountIdOf(req);
    res.status(200).json({ quotas: await this.operations.accountQuotas(accountId) });
  };

  setQuota = async (req: Request, res: Response): Promise<void> => {
    const { user } = requireAuthContext(req);
    const accountId = accountIdOf(req);
    const { kind, limit } = req.body as SetQuotaOverrideRequest;

    const quotas = await this.operations.setQuotaOverride(user.id, accountId, kind, limit);
    res.status(200).json({ quotas });
  };

  audit = async (_req: Request, res: Response): Promise<void> => {
    res.status(200).json({ entries: await this.operations.auditTrail() });
  };

  sweep = async (req: Request, res: Response): Promise<void> => {
    const { user } = requireAuthContext(req);
    const { dryRun } = req.body as RunSweepRequest;

    const report = await this.operations.sweep(user.id, dryRun);
    res.status(200).json(toView(report));
  };
}

function accountIdOf(req: Request): string {
  const raw: unknown = req.params.accountId;
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new AppError('VALIDATION_FAILED', 'No account was named.');
  }
  return raw;
}

/**
 * The report as the browser reads it.
 *
 * Dates become strings and `skipped` becomes explicitly null, because the shape
 * that crosses the wire is validated against a schema and an absent field and a
 * null one are different things there.
 */
function toView(report: SweepReport): SweepReportView {
  return {
    startedAt: report.startedAt.toISOString(),
    finishedAt: report.finishedAt.toISOString(),
    dryRun: report.dryRun,
    containers: step(report.containers),
    networks: step(report.networks),
    databases: step(report.databases),
    objects: step(report.objects),
    sessions: report.sessions,
    tokens: report.tokens,
  };
}

function step(value: SweepStep): SweepReportView['containers'] {
  return {
    found: value.found,
    orphaned: value.orphaned,
    removed: value.removed,
    failed: value.failed,
    skipped: value.skipped ?? null,
  };
}
