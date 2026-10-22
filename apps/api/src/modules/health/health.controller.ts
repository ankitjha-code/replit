import type { Request, Response } from 'express';
import { publicReadiness, type HealthService } from './health.service.js';

/**
 * Translates between HTTP and the health service. No logic lives here beyond
 * choosing a status code from the service's verdict, and choosing how much of
 * it the caller may see.
 */
export class HealthController {
  constructor(private readonly service: HealthService) {}

  live = (_req: Request, res: Response): void => {
    res.status(200).json(this.service.live());
  };

  /**
   * The full report for an operator; names and verdicts for everybody else.
   *
   * The status code is the same either way, so a load balancer or an uptime
   * monitor reads the same answer an operator does.
   */
  ready = async (req: Request, res: Response): Promise<void> => {
    const report = await this.service.ready();
    const body = req.auth?.user.isOperator === true ? report : publicReadiness(report);
    res.status(report.status === 'down' ? 503 : 200).json(body);
  };
}
